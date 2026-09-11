import { backedPools, compareAllRoutes, isWaxToken, quoteConstantProduct } from "./amm";
import {
  decorate,
  scoreSignal,
  type Candle,
  type SignalSnap,
  type TickParams,
} from "./indicators";
import type { LeefPool, LeefSnapshot, SwapRoute } from "./types";

/* ------------------------------------------------------------------ */
/* Strategy catalog                                                    */
/* ------------------------------------------------------------------ */

export type BotStrategy = "signal" | "meanrev" | "spread" | "grid" | "dca";

export const STRATEGIES: {
  id: BotStrategy;
  name: string;
  tagline: string;
  detail: string;
  bestFor: string;
}[] = [
  {
    id: "signal",
    name: "Signal rider",
    tagline: "Ride the blended engine vote",
    detail:
      "Seven indicator engines vote on every 30s book print. The bot buys when the blend flips bullish with enough confidence, and exits when it flips bearish — with take-profit, stop-loss and trailing-stop guards on top.",
    bestFor: "Trending tapes",
  },
  {
    id: "meanrev",
    name: "Mean reversion",
    tagline: "Buy the dip, sell the rip",
    detail:
      "Buys when the price stretches below the Bollinger floor with RSI oversold, then sells back at the band midline or when RSI recovers. Classic range-harvesting on choppy books.",
    bestFor: "Sideways chop",
  },
  {
    id: "spread",
    name: "Spread arb",
    tagline: "Atomic cross-pool arbitrage",
    detail:
      "When two LEEF books diverge, it buys on the cheap book and sells on the rich one as TWO transfers inside ONE transaction. If the profit isn't there at execution, the chain reverts everything — you never end up holding the bag.",
    bestFor: "Any market, low risk",
  },
  {
    id: "grid",
    name: "Grid stepper",
    tagline: "Harvest every step of the range",
    detail:
      "Sets a step size around the last trade price. Every drop of a full step buys a clip; every rise of a full step sells. Volatility itself becomes the yield.",
    bestFor: "Wobbly ranges",
  },
  {
    id: "dca",
    name: "DCA accumulator",
    tagline: "Stack LEEF on a schedule",
    detail:
      "Buys a fixed clip every cycle until the position cap is reached, then sits until the take-profit target. The slow, boring, survivable strategy.",
    bestFor: "Long-term stacking",
  },
];

/** Indicator blend used for bot decisions on the real 30s price series. */
const BOT_TICK_PARAMS: TickParams = {
  smaPeriod: 20,
  emaPeriod: 21,
  bbPeriod: 20,
  bbStd: 2,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  rsiPeriod: 14,
  stochK: 14,
  stochD: 3,
  sensitivity: 1,
  engines: { bb: true, macd: true, rsi: true, ema: true, sma: false, stoch: true, vwap: true },
};

/** Minimum real prints before the engines' vote is trusted. */
export const BOT_WARMUP_POINTS = 34;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type BotGoals = {
  /** Per-position take-profit, percent. */
  takeProfitPct: number;
  /** Per-position stop-loss, percent. */
  stopLossPct: number;
  /** Trailing stop: arms once profit passes this, sells on this much giveback. */
  trailingPct: number;
  /** Stop the bot for the session once realized P&L reaches this USD amount. */
  sessionGoalUsd: number;
  /** Stop the bot if session equity drawdown exceeds this percent. */
  maxDrawdownPct: number;
};

export type BotRisk = {
  /** WAX spent per buy clip. */
  clipWax: number;
  /** Max WAX-value held in LEEF at once. */
  maxPositionWax: number;
  maxImpactPct: number;
  cooldownSec: number;
  maxTradesHour: number;
  slippage: number;
  /** Signal strategy: minimum blend confidence (0-1 shown as %). */
  minConfidence: number;
  /** Spread strategy: minimum atomic profit after fees/impact, percent. */
  minEdgePct: number;
  /** Grid strategy: step size, percent. */
  gridStepPct: number;
};

export const DEFAULT_GOALS: BotGoals = {
  takeProfitPct: 6,
  stopLossPct: 4,
  trailingPct: 3,
  sessionGoalUsd: 0,
  maxDrawdownPct: 0,
};

export const DEFAULT_RISK: BotRisk = {
  clipWax: 10,
  maxPositionWax: 60,
  maxImpactPct: 3,
  cooldownSec: 60,
  maxTradesHour: 10,
  slippage: 0.6,
  minConfidence: 55,
  minEdgePct: 1.2,
  gridStepPct: 2.5,
};

export type Position = {
  amountLeef: number;
  /** USD per LEEF at entry. */
  entryUsd: number;
  /** USD value of the WAX spent at entry. */
  entryCostUsd: number;
  /** WAX spent. */
  entryWax: number;
  since: number;
  /** Highest USD-per-LEEF seen since entry (trailing stop). */
  highUsd: number;
  /** Wallet mode the position was opened in — guards mode mismatches after reloads. */
  mode: "paper" | "live";
};

export type PricePoint = { t: number; usd: number };

export type ArbPlan = {
  buyPool: LeefPool;
  sellPool: LeefPool;
  waxIn: number;
  leefMid: number;
  waxOut: number;
  profitPct: number;
  impactPct: number;
};

export type Decision =
  | { kind: "buy"; amountWax: number; route: SwapRoute; reason: string; confidence: number }
  | { kind: "sell"; amountLeef: number; route: SwapRoute; reason: string; confidence: number }
  | { kind: "arb"; plan: ArbPlan; reason: string }
  | { kind: "hold"; reason: string }
  | { kind: "stop"; reason: string };

export type BotInput = {
  now: number;
  snap: LeefSnapshot;
  series: PricePoint[];
  running: boolean;
  strategy: BotStrategy;
  goals: BotGoals;
  risk: BotRisk;
  position: Position | null;
  gridAnchor: number | null;
  balances: Record<string, number>;
  cooldownUntil: number;
  tradesThisHour: number;
  sessionRealizedUsd: number;
  sessionStartEquityUsd: number;
  /** Force a manual trade, bypassing strategy entry/exit logic. */
  force?: "buy" | "sell" | null;
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function seriesToCandles(series: PricePoint[]): Candle[] {
  return series.map((p) => ({
    t: p.t,
    o: p.usd,
    h: p.usd,
    l: p.usd,
    c: p.usd,
    v: 1,
    label: new Date(p.t).toISOString().slice(11, 16),
  }));
}

/** Blended engine vote over the real 30s USD series. */
export function botSignal(series: PricePoint[]): SignalSnap & { warmed: boolean } {
  if (series.length < BOT_WARMUP_POINTS) {
    return { score: 0, bias: "hold", confidence: 0, readings: [], warmed: false };
  }
  const points = decorate(seriesToCandles(series), BOT_TICK_PARAMS);
  return { ...scoreSignal(points, BOT_TICK_PARAMS), warmed: true };
}

/** Simple momentum: pct change over the last `points` prints. */
export function momentumPct(series: PricePoint[], points = 6): number {
  if (series.length < points + 1) return 0;
  const a = series[series.length - 1 - points]!.usd;
  const b = series[series.length - 1]!.usd;
  return a > 0 ? b / a - 1 : 0;
}

/** Latest RSI and Bollinger %B from the real series. */
export function reversionRead(series: PricePoint[]): { rsi: number | null; pctB: number | null } {
  if (series.length < BOT_WARMUP_POINTS) return { rsi: null, pctB: null };
  const points = decorate(seriesToCandles(series), BOT_TICK_PARAMS);
  const last = points[points.length - 1];
  return { rsi: last?.rsi ?? null, pctB: last?.pctB ?? null };
}

function bestBuyRoute(snap: LeefSnapshot, amountWax: number): SwapRoute | null {
  if (amountWax <= 0) return null;
  return compareAllRoutes(snap.pools, snap.aux, amountWax, "WAX", "LEEF")[0] ?? null;
}

function bestSellRoute(snap: LeefSnapshot, amountLeef: number): SwapRoute | null {
  if (amountLeef <= 0) return null;
  return compareAllRoutes(snap.pools, snap.aux, amountLeef, "LEEF", "WAX")[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Atomic spread arbitrage                                             */
/* ------------------------------------------------------------------ */

/**
 * Find a two-pool atomic arb: buy LEEF with WAX on the cheaper WAX book,
 * sell it on the richer one — both legs in a single transaction.
 * Constant-product quotes on real reserves are conservative for Alcor's
 * concentrated pools, which is the safe direction for a min-out guard.
 */
export function findArb(
  snap: LeefSnapshot,
  waxIn: number,
  minProfitPct: number,
): ArbPlan | null {
  if (!(waxIn > 0)) return null;
  const waxPools = backedPools(snap.pools).filter((p) => isWaxToken(p.pair));
  if (waxPools.length < 2) return null;

  let best: ArbPlan | null = null;
  for (const buyPool of waxPools) {
    const q1 = quoteConstantProduct(waxIn, buyPool.pair.quantity, buyPool.leef.quantity, buyPool.fee);
    if (q1.amountOut <= 0 || q1.priceImpact > 0.2) continue;
    for (const sellPool of waxPools) {
      if (sellPool.id === buyPool.id) continue;
      const q2 = quoteConstantProduct(q1.amountOut, sellPool.leef.quantity, sellPool.pair.quantity, sellPool.fee);
      if (q2.amountOut <= 0 || q2.priceImpact > 0.2) continue;
      const profitPct = q2.amountOut / waxIn - 1;
      const impactPct = 1 - (1 - q1.priceImpact) * (1 - q2.priceImpact);
      if (!best || profitPct > best.profitPct) {
        best = {
          buyPool,
          sellPool,
          waxIn,
          leefMid: q1.amountOut,
          waxOut: q2.amountOut,
          profitPct,
          impactPct,
        };
      }
    }
  }
  if (best && best.profitPct * 100 >= minProfitPct) return best;
  return null;
}

/* ------------------------------------------------------------------ */
/* The decision engine                                                 */
/* ------------------------------------------------------------------ */

function hold(reason: string): Decision {
  return { kind: "hold", reason };
}

export function evaluateBot(input: BotInput): Decision {
  const { snap, risk, goals, position, strategy } = input;
  const now = input.now;
  const leefUsd = snap.leefUsd;
  const waxUsd = snap.waxUsd;

  if (!input.running && !input.force) return hold("Bot is stopped");
  if (snap.source !== "live") return hold("Book is stale — waiting for live Alcor data");
  if (!(leefUsd > 0) || !(waxUsd > 0)) return hold("Waiting for a priced book");

  // Session goal / drawdown circuit breakers.
  if (goals.sessionGoalUsd > 0 && input.sessionRealizedUsd >= goals.sessionGoalUsd) {
    return {
      kind: "stop",
      reason: `Session goal reached (+$${input.sessionRealizedUsd.toFixed(2)} realized) — bot stopped`,
    };
  }
  const equityUsd =
    (input.balances.WAX ?? 0) * waxUsd + (input.balances.LEEF ?? 0) * leefUsd;
  if (
    goals.maxDrawdownPct > 0 &&
    input.sessionStartEquityUsd > 0 &&
    equityUsd < input.sessionStartEquityUsd * (1 - goals.maxDrawdownPct / 100)
  ) {
    return {
      kind: "stop",
      reason: `Max drawdown ${goals.maxDrawdownPct}% hit (equity $${equityUsd.toFixed(2)}) — bot stopped`,
    };
  }

  if (!input.force) {
    if (now < input.cooldownUntil) {
      const s = Math.ceil((input.cooldownUntil - now) / 1000);
      return hold(`Cooldown ${s}s`);
    }
    if (input.tradesThisHour >= risk.maxTradesHour) return hold("Hourly trade cap reached");
  }

  const signal = botSignal(input.series);

  /* ---------------- position management (all strategies) ---------- */

  if (position && position.amountLeef > 0) {
    const pnlPct = (leefUsd / position.entryUsd - 1) * 100;
    const sellRoute = bestSellRoute(snap, position.amountLeef);

    const sellAll = (reason: string): Decision | null => {
      if (!sellRoute) return null;
      if (sellRoute.priceImpact * 100 > risk.maxImpactPct) {
        return hold(`Exit impact ${(sellRoute.priceImpact * 100).toFixed(1)}% above cap — waiting for depth`);
      }
      return {
        kind: "sell",
        amountLeef: position.amountLeef,
        route: sellRoute,
        reason,
        confidence: signal.confidence,
      };
    };

    if (input.force === "sell") {
      return sellAll(`Manual sell · position ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`) ??
        hold("No backed route to sell into");
    }

    // Stop-loss.
    if (goals.stopLossPct > 0 && pnlPct <= -goals.stopLossPct) {
      const d = sellAll(`Stop-loss ${pnlPct.toFixed(2)}% ≤ −${goals.stopLossPct}% · cutting the position`);
      if (d) return d;
    }
    // Take-profit.
    if (goals.takeProfitPct > 0 && pnlPct >= goals.takeProfitPct) {
      const d = sellAll(`Take-profit +${pnlPct.toFixed(2)}% ≥ +${goals.takeProfitPct}% · banking it`);
      if (d) return d;
    }
    // Trailing stop: armed once profit exceeded trailingPct, fires on giveback.
    if (goals.trailingPct > 0 && position.highUsd > 0) {
      const peakPct = (position.highUsd / position.entryUsd - 1) * 100;
      const givebackPct = (leefUsd / position.highUsd - 1) * 100;
      if (peakPct >= goals.trailingPct && givebackPct <= -goals.trailingPct) {
        const d = sellAll(
          `Trailing stop · peaked +${peakPct.toFixed(1)}%, gave back ${givebackPct.toFixed(1)}% — locking +${pnlPct.toFixed(2)}%`,
        );
        if (d) return d;
      }
    }

    // Strategy exits.
    if (strategy === "signal" && signal.warmed && signal.bias === "sell") {
      const d = sellAll(
        `Engine vote flipped sell (${Math.round(signal.confidence * 100)}% conf) · position ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
      );
      if (d) return d;
    }
    if (strategy === "meanrev") {
      const { rsi, pctB } = reversionRead(input.series);
      if (rsi != null && pctB != null && (rsi >= 62 || pctB >= 0.9)) {
        const d = sellAll(
          `Reversion exit · RSI ${rsi.toFixed(0)} / %B ${pctB.toFixed(2)} back at the mean · position ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
        );
        if (d) return d;
      }
    }
    if (strategy === "grid" && input.gridAnchor != null) {
      const stepUp = input.gridAnchor * (1 + risk.gridStepPct / 100);
      if (leefUsd >= stepUp) {
        const d = sellAll(
          `Grid step +${risk.gridStepPct}% filled · ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% on the leg`,
        );
        if (d) return d;
      }
    }
    if (strategy === "dca") {
      // Keep stacking until the position cap, then ride to the take-profit.
      const roomWax = risk.maxPositionWax - position.entryWax;
      const clip = Math.min(risk.clipWax, roomWax, input.balances.WAX ?? 0);
      if (clip > 0.01) {
        const route = bestBuyRoute(snap, clip);
        if (!route) return hold("No backed route for the DCA clip");
        if (route.priceImpact * 100 > risk.maxImpactPct) {
          return hold(`DCA clip impact ${(route.priceImpact * 100).toFixed(1)}% above cap — waiting`);
        }
        return {
          kind: "buy",
          amountWax: clip,
          route,
          reason: `DCA clip · averaging in at ${(leefUsd * 1e6).toFixed(4)} USD/1M (${(position.entryWax + clip).toFixed(1)}/${risk.maxPositionWax} WAX stacked)`,
          confidence: signal.confidence,
        };
      }
      return hold(
        `Cap reached · holding ${position.amountLeef.toLocaleString()} LEEF · ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% vs entry — TP at +${goals.takeProfitPct}%`,
      );
    }
    return hold(
      `Holding ${position.amountLeef.toLocaleString()} LEEF · ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% vs entry · vote ${signal.warmed ? signal.bias : "warming up"}`,
    );
  }

  if (input.force === "sell") return hold("No open position to sell");

  /* ------------------------------ entries ------------------------- */

  // Spread arb runs flat-or-not and never opens a directional position.
  if (strategy === "spread") {
    const waxAvail = Math.min(risk.clipWax, input.balances.WAX ?? 0);
    if (waxAvail <= 0.5) return hold("Not enough WAX for an arb clip");
    // Leg 1's min-out buffer shrinks leg 2's input, so the on-chain profit
    // floor needs the raw spread to clear it with slippage headroom.
    const gatePct =
      ((1 + risk.minEdgePct / 100) / Math.max(0.9, 1 - risk.slippage / 100) - 1) * 100;
    const plan = findArb(snap, waxAvail, gatePct);
    if (!plan) {
      const probe = findArb(snap, waxAvail, -100);
      const spreadTxt = probe
        ? `best spread ${(probe.profitPct * 100).toFixed(2)}%`
        : "no two WAX books";
      return hold(
        `No atomic arb ≥ ${risk.minEdgePct}% after fees+impact (${spreadTxt})`,
      );
    }
    return {
      kind: "arb",
      plan,
      reason: `Arb #${plan.buyPool.id}→#${plan.sellPool.id} · est +${(plan.profitPct * 100).toFixed(2)}% after fees · impact ${(plan.impactPct * 100).toFixed(1)}%`,
    };
  }

  if (input.force === "buy") {
    const amountWax = Math.min(risk.clipWax, input.balances.WAX ?? 0);
    const route = bestBuyRoute(snap, amountWax);
    if (!route) return hold("No backed route to buy with");
    return {
      kind: "buy",
      amountWax,
      route,
      reason: `Manual buy clip · ${route.label}`,
      confidence: signal.confidence,
    };
  }

  const waxAvail = input.balances.WAX ?? 0;
  const clip = Math.min(risk.clipWax, waxAvail);
  const positionUsd = 0; // flat here
  const roomWax = risk.maxPositionWax - positionUsd / Math.max(waxUsd, 1e-9);
  const amountWax = Math.min(clip, Math.max(roomWax, 0));

  const tryBuy = (reason: string): Decision => {
    if (!(amountWax > 0.01)) return hold("Position cap reached or no WAX available");
    const route = bestBuyRoute(snap, amountWax);
    if (!route) return hold("No backed route for this size");
    if (route.priceImpact * 100 > risk.maxImpactPct) {
      return hold(`Entry impact ${(route.priceImpact * 100).toFixed(1)}% above ${risk.maxImpactPct}% cap`);
    }
    return { kind: "buy", amountWax, route, reason, confidence: signal.confidence };
  };

  switch (strategy) {
    case "signal": {
      if (!signal.warmed) {
        return hold(`Engines warming up — ${input.series.length}/${BOT_WARMUP_POINTS} prints collected`);
      }
      const conf = Math.round(signal.confidence * 100);
      if (signal.bias === "buy" && conf >= risk.minConfidence) {
        const votes = signal.readings
          .filter((r) => r.score > 0.12)
          .map((r) => r.id.toUpperCase())
          .join("+");
        return tryBuy(`Engine vote BUY ${conf}% conf (${votes || "blend"}) · momentum ${(momentumPct(input.series) * 100).toFixed(2)}%`);
      }
      return hold(`Vote ${signal.bias} · ${conf}% conf (need ≥ ${risk.minConfidence}% buy)`);
    }
    case "meanrev": {
      const { rsi, pctB } = reversionRead(input.series);
      if (rsi == null || pctB == null) {
        return hold(`Engines warming up — ${input.series.length}/${BOT_WARMUP_POINTS} prints collected`);
      }
      if (rsi <= 30 && pctB <= 0.1) {
        return tryBuy(`Oversold · RSI ${rsi.toFixed(0)} ≤ 30, %B ${pctB.toFixed(2)} at the lower band`);
      }
      return hold(`RSI ${rsi.toFixed(0)} · %B ${pctB.toFixed(2)} — waiting for an oversold tag`);
    }
    case "grid": {
      const anchor = input.gridAnchor;
      if (anchor == null) {
        return tryBuy("Grid seed buy — anchoring the grid at market");
      }
      const stepDown = anchor * (1 - risk.gridStepPct / 100);
      if (leefUsd <= stepDown) {
        return tryBuy(`Grid step −${risk.gridStepPct}% filled at the bid`);
      }
      const distDown = (leefUsd / stepDown - 1) * 100;
      return hold(`Grid armed · next buy ${distDown.toFixed(1)}% below, next sell +${risk.gridStepPct}% above last fill`);
    }
    case "dca": {
      return tryBuy("Scheduled accumulation clip");
    }
    case "spread":
      return hold("Spread scan only");
  }
}
