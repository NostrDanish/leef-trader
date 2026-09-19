import {
  backedPools,
  isLeefToken,
  isWaxToken,
  quoteConstantProduct,
  virtualLeefPairReserves,
} from "./amm";
import { bestExecutionRoute } from "./route-optimizer";
import { planLeefTape, planNextAction } from "./next-action";
import {
  DEFAULT_GROWTH_TARGETS,
  hopsForGrowth,
  normalizeTargets,
  planGrowthAction,
  type GrowthMode,
  type GrowthPlan,
  type GrowthTarget,
} from "./growth-engine";
import { realizedVolPerSec, usdPriceOf } from "./cost-model";
import { classifyRegime, dangerScore, regimeWeight, type FlowRiskContext } from "./regime";
import { balanceForIdentifier, markPortfolioUsd } from "@/lib/wallet/balances";
import {
  decorate,
  scoreSignal,
  type Candle,
  type SignalSnap,
  type TickParams,
} from "./indicators";
import { optimizeEntrySize, scoreOpportunity } from "./net-edge";
import {
  DEFAULT_MAX_POSITION_USD,
  DEFAULT_MIN_TRADE_USD,
  DEFAULT_OPERATIONAL_RESERVE_USD,
  usdToTokenBounds,
  type UsdBounds,
} from "./risk-usd";
import type { LeefPool, LeefSnapshot, SwapRoute } from "./types";
import {
  buildScoredOpportunity,
  calibrationHaircut,
  inventoryFactor,
  opportunityFingerprint,
  rejectOpportunity,
  routeComplexity,
  selectBestOpportunity,
  type CalibrationMemory,
  type OpportunityGate,
  type ScoredOpportunity,
} from "./opportunity";

/* ------------------------------------------------------------------ */
/* Strategy catalog                                                    */
/* ------------------------------------------------------------------ */

export type BotStrategy =
  | "auto"
  | "unleashed"
  | "signal"
  | "meanrev"
  | "spread"
  | "grid"
  | "dca"
  | "volume"
  | "volume-x"
  | "growth";

export const STRATEGIES: {
  id: BotStrategy;
  name: string;
  tagline: string;
  detail: string;
  bestFor: string;
}[] = [
  {
    id: "auto",
    name: "Auto",
    tagline: "Orchestrator — strategies compete on expected value",
    detail:
      "Auto ranks scored opportunities AND a holdings-based next hop (WAX/LEEF/TLM/USDC/… → best one-shot swap or cycle). After every fill the graph is rebuilt. HOLD is a successful outcome. Volume is last and never runs just to print tape.",
    bestFor: "Default — one mode that adapts",
  },
  {
    id: "unleashed",
    name: "Unleashed",
    tagline: "Trade — mix everything, no knobs",
    detail:
      "One button. Mixes signal, mean-reversion, grid, arb, next-hop and volume. Clip size is picked inside min–max from the wallet and the route — never always the max. Hops vary up to your cap. HOLD only when the wallet or the book cannot trade.",
    bestFor: "Just trade",
  },
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
  {
    id: "volume",
    name: "Volume maker",
    tagline: "Boost book volume at bounded cost",
    detail:
      "Echoes WAX → LEEF → WAX in ONE atomic transaction every cycle — the chain sees real volume, you keep the spread minus a hard loss floor you set. If the round trip would cost more than your budget, the transaction reverts and nothing moves. Clip size is chosen inside min–max from wallet + route, not always the max.",
    bestFor: "Warming the tape",
  },
  {
    id: "volume-x",
    name: "Volume extreme",
    tagline: "Any token → LEEF tape, mixed sizes",
    detail:
      "Prints LEEF volume through whatever you hold: TLM, USDC, WAX, TACO, …. Each clip is a different size between min and max. Prefers profit, accepts zero-loss after LP fees. Still won't spend more than the wallet or sign a stale quote.",
    bestFor: "LEEF tape, any pair",
  },
  {
    id: "growth",
    name: "Treasure growth",
    tagline: "Don't trade pairs. Grow assets.",
    detail:
      "You name 1–3 treasures (e.g. LEEF 60 / WAX 30 / TLM 10). The Growth Brain maps every holding onto the book and asks what sequence increases those token counts. Token count is the objective; economic value, liquidity, fees and execution risk are hard constraints. HOLD is a successful decision — and it always says why.",
    bestFor: "Accumulate a bag",
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
  // VWAP off: the bot series has volume=1, so "VWAP" is a TWAP of the print
  // window — not traded volume. Keep it on the chart, not in the vote.
  engines: { bb: true, macd: true, rsi: true, ema: true, sma: false, stoch: true, vwap: false },
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
  /** Minimum notional per new trade, USD. Converted to quote-token units at the live mark. */
  minTradeUsd: number;
  /** Maximum marked position value, USD. Remaining capacity sizes the next clip. */
  maxPositionUsd: number;
  /** USD value kept unspent in the quote token for continued operation. */
  operationalReserveUsd: number;
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
  /** Volume strategy: max acceptable round-trip loss, percent. */
  maxEchoLossPct: number;
  /**
   * Minimum NET edge an entry must clear after ALL modeled costs (round-trip
   * execution, slippage allowance, opportunity decay, resource + failure
   * cost), percent of notional. 0.1% keeps WAX micro-edges viable while
   * refusing trades whose costs eat the thesis.
   */
  minNetEdgePct: number;
  /**
   * Maximum age of the book a decision may act on, seconds. Default 45
   * assumed a 30s pull. At runtime the loop uses max(this, syncSec + 15)
   * so a Live/10s book is never treated as stale.
   */
  maxQuoteAgeSec: number;
  /** Graph depth cap for routing (1–10). Strategies pick ≤ this, not always 10. */
  maxHops: number;
};

export const DEFAULT_GOALS: BotGoals = {
  takeProfitPct: 6,
  stopLossPct: 4,
  trailingPct: 3,
  sessionGoalUsd: 0,
  maxDrawdownPct: 0,
};

export const DEFAULT_RISK: BotRisk = {
  minTradeUsd: DEFAULT_MIN_TRADE_USD,
  maxPositionUsd: DEFAULT_MAX_POSITION_USD,
  operationalReserveUsd: DEFAULT_OPERATIONAL_RESERVE_USD,
  maxImpactPct: 3,
  cooldownSec: 15,
  maxTradesHour: 120,
  slippage: 0.6,
  minConfidence: 55,
  minEdgePct: 0.3,
  gridStepPct: 2.5,
  // Two 0.3% LP tiers + impact typically cost 0.6–1.5%. Inside this budget
  // a volume echo is "zero-loss average" after fees — the on-chain min-out
  // still reverts anything worse. Not wash trading: cost is bounded.
  maxEchoLossPct: 1.5,
  minNetEdgePct: 0.1,
  maxQuoteAgeSec: 45,
  maxHops: 4,
};

export type Position = {
  /** Amount of the base token held (legacy field name `amountLeef`). */
  amountLeef: number;
  entryUsd: number;
  entryCostUsd: number;
  /** Amount of the quote token spent to enter (legacy field name `entryWax`). */
  entryWax: number;
  since: number;
  highUsd: number;
  mode: "paper" | "live";
  predEdgePct?: number;
  strategy?: BotStrategy;
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
  /** Alcor router legs for WAX→LEEF (may be split across routes). */
  buyLegs?: ArbLeg[];
  /** Alcor router legs for LEEF→WAX (may be split across routes). */
  sellLegs?: ArbLeg[];
  /** Exact LEEF amount the Alcor router quoted for the first leg. */
  quotedLeef?: number;
  /** Exact WAX amount the Alcor router quoted for the second leg. */
  quotedWax?: number;
};

/** One split leg from Alcor's router: an input asset plus its ready memo. */
export type ArbLeg = {
  input: string;
  output: string;
  memo: string;
  route: number[];
};

export type Decision =
  | {
      kind: "buy";
      amountWax: number;
      route: SwapRoute;
      reason: string;
      confidence: number;
      /** Thesis the size scanner used — pre-trade re-optimize must reuse this. */
      expectedGrossPct?: number;
      /** Net-edge verdict that approved the entry (journal/calibration). */
      edge?: { netEdgePct: number; netProfitUsd: number; score: number };
      opportunity?: ScoredOpportunity;
    }
  | {
      kind: "swap";
      tokenIn: string;
      tokenOut: string;
      amountIn: number;
      route: SwapRoute;
      reason: string;
      opportunity?: ScoredOpportunity;
      /** Treasure-growth plan — re-verified against the exact venue quote before sign. */
      growthPlan?: GrowthPlan;
      /**
       * Exact-gate floor for non-growth swaps: minimum acceptable net percent
       * on the venue-quoted output (profit paths ≥ 0; tape ≥ −loss budget).
       */
      minNetPct?: number;
    }
  | { kind: "sell"; amountLeef: number; route: SwapRoute; reason: string; confidence: number }
  | {
      kind: "arb";
      plan: ArbPlan;
      reason: string;
      /** spread = profit floor enforced; volume = loss budget enforced. */
      arbKind?: "spread" | "volume";
      opportunity?: ScoredOpportunity;
    }
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
  /** Asset being accumulated (default LEEF). */
  base?: string;
  /** Quote token bought with / sold into (WAX, WAXUSDC, USDT, …). Default WAX. */
  quote?: string;
  /** Force a manual trade, bypassing strategy entry/exit logic. */
  force?: "buy" | "sell" | null;
  /** Predicted-vs-realized memory per strategy — haircuts over-optimistic theses. */
  calibration?: Record<string, CalibrationMemory>;
  /** Treasure mix for the growth strategy (1–3 assets). */
  growthTargets?: GrowthTarget[];
  growthMode?: GrowthMode;
  /** Execution errors in the recent window — feeds the danger score. */
  recentFailures?: number;
  /**
   * Swap-flow risk context (E-1, feature-flagged by the caller). Risk only:
   * it may raise the danger score; it NEVER creates an entry.
   */
  flow?: FlowRiskContext | null;
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
  if (!(a > 0) || !(b > 0)) return 0;
  return (b / a - 1) * 100;
}

/** Clip chooser for volume/volume-x/unleashed: mixed sizes inside [min, max]. */
export function pickClipInBand(min: number, max: number, seed: number): number {
  if (!(max > 0)) return 0;
  if (max <= min) return max;
  const ladder = [0, 0.08, 0.15, 0.3, 0.5, 0.75, 1];
  const r = (Math.abs(Math.floor(seed)) >>> 0) % ladder.length;
  const f = ladder[r]!;
  return Math.min(max, Math.max(min, min + (max - min) * f));
}

/** Adaptive cooldown: slower after losses / hyper clips, faster in flow. */
export function adaptiveCooldownSec(baseSec: number, strategy: BotStrategy, lastPnlUsd: number | null): number {
  let c = baseSec;
  if (strategy === "spread" || strategy === "volume") c = Math.max(20, c * 0.6);
  if (lastPnlUsd != null && lastPnlUsd < 0) c *= 1.8;
  return Math.max(8, Math.round(c));
}

/** Route depth by strategy. Never above the user cap; rarely the full 10. */
export function hopsForStrategy(strategy: BotStrategy, maxHops: number): number {
  const cap = Math.max(2, Math.min(10, maxHops));
  if (strategy === "volume-x") return Math.min(3, cap);
  if (strategy === "volume" || strategy === "spread") return Math.min(3, cap);
  if (strategy === "grid" || strategy === "dca") return Math.min(4, cap);
  if (strategy === "signal" || strategy === "meanrev") return Math.min(4, cap);
  if (strategy === "unleashed") return Math.min(6, cap);
  return cap;
}

/* ------------------------------------------------------------------ */
/* Spread arb — atomic, riskless by construction                       */
/* ------------------------------------------------------------------ */

/**
 * Find a profitable atomic WAX → LEEF → WAX echo across two LEEF books.
 * CLMM pools quote over V3 virtual reserves (tick-price anchored — P-A);
 * pools without CLMM state fall back to raw-reserve CP (exact for true-CP
 * Defibox/Taco books). Uses plan.waxIn as the trade size.
 */
export function findArb(
  snap: LeefSnapshot,
  waxIn: number,
  minProfitPct: number,
): ArbPlan | null {
  const pools = backedPools(snap.pools).filter((p) => isWaxToken(p.pair));
  if (pools.length < 2 || waxIn <= 0) return null;
  const quote = (p: LeefPool) => {
    const v = virtualLeefPairReserves(p);
    const leef = v?.leef ?? p.leef.quantity;
    const pair = v?.pair ?? p.pair.quantity;
    return {
      buy: quoteConstantProduct(waxIn, pair, leef, p.fee),
      sellQuote: (leefMid: number) => quoteConstantProduct(leefMid, leef, pair, p.fee),
    };
  };
  let best: ArbPlan | null = null;
  for (const buyPool of pools) {
    const bq = quote(buyPool).buy;
    if (bq.amountOut <= 0) continue;
    for (const sellPool of pools) {
      if (sellPool.id === buyPool.id) continue;
      const sq = quote(sellPool).sellQuote(bq.amountOut);
      if (sq.amountOut <= 0) continue;
      const profitPct = sq.amountOut / waxIn - 1;
      if (profitPct * 100 <= minProfitPct) continue;
      const plan: ArbPlan = {
        buyPool,
        sellPool,
        waxIn,
        leefMid: bq.amountOut,
        waxOut: sq.amountOut,
        profitPct,
        impactPct: (bq.priceImpact + sq.priceImpact) * 100,
      };
      if (!best || plan.waxOut > best.waxOut) best = plan;
    }
  }
  return best;
}

/** Largest arb clip: scaled to the shallow side, capped by wallet + impact. */
export function findBestArb(
  snap: LeefSnapshot,
  maxWax: number,
  minProfitPct: number,
  isEcho: boolean,
  minWax = 0,
): ArbPlan | null {
  if (maxWax <= 0) return null;
  for (const f of [1, 0.5, 0.25, 0.125, 0.0625]) {
    const size = maxWax * f;
    if (size + 1e-12 < minWax) break;
    const plan = findArb(snap, size, isEcho ? -100 : minProfitPct);
    if (!plan) continue;
    if (isEcho) {
      // Echo: accept any round trip inside the loss budget.
      if (plan.profitPct * 100 >= minProfitPct) return plan;
      continue;
    }
    return plan;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The engine                                                          */
/* ------------------------------------------------------------------ */

function boundsFor(input: BotInput, snap: LeefSnapshot): UsdBounds | { error: string } {
  return usdToTokenBounds({
    snap,
    quote: input.quote ?? "WAX",
    base: input.base ?? "LEEF",
    risk: input.risk,
    position: input.position,
    balances: input.balances,
  });
}

/** Shared regime/danger gate. Weight scales ALL entries, never below 0. */
function dangerGate(
  input: BotInput,
  snap: LeefSnapshot,
  series: PricePoint[],
): { weight: number; blockReason: string | null; danger: number; regime: string } {
  const regime = classifyRegime({
    series,
    poolPricesUsd: snap.pools.map((p) => p.usdPerLeef ?? 0).filter((v) => v > 0),
  });
  const danger = dangerScore({
    quoteAgeMs: Math.max(0, input.now - Date.parse(snap.fetchedAt)),
    maxQuoteAgeMs: Math.max(15, input.risk.maxQuoteAgeSec) * 1000,
    volPct: regime.volPct,
    dislocationPct: regime.dislocationPct,
    liquidityUsd: Math.max(0, ...snap.pools.map((p) => p.tvlUsd)),
    recentFailures: input.recentFailures ?? 0,
    flow: input.flow ?? null,
  });
  if (danger.score >= 80) {
    return {
      weight: 0,
      blockReason: `Danger ${danger.score.toFixed(0)}/100 (${danger.explain.join("; ")}) — all entries blocked`,
      danger: danger.score,
      regime: regime.regime,
    };
  }
  const w = regimeWeight(regime) * (danger.score >= 50 ? 0.5 : 1);
  return { weight: w, blockReason: null, danger: danger.score, regime: regime.regime };
}

/**
 * Build a scored opportunity for the Auto orchestrator: strategy thesis
 * → size optimization → opportunity score → calibration haircut → inventory
 * factor → dead-clip rejection memory.
 */
function buildOpportunity(opts: {
  strategy: BotStrategy;
  input: BotInput;
  snap: LeefSnapshot;
  bounds: UsdBounds;
  series: PricePoint[];
  thesis: { grossPct: number; confidence: number; label: string };
  gate: OpportunityGate;
  weight: number;
}): ScoredOpportunity | null {
  const { input, snap, bounds, series, thesis, gate, weight } = opts;
  const tokenIn = input.quote ?? "WAX";
  const tokenOut = input.base ?? "LEEF";
  const maxIn = bounds.maxIn * weight;
  if (maxIn + 1e-12 < bounds.minIn) return null;
  const grossPct = thesis.grossPct * calibrationHaircut(input.calibration?.[opts.strategy]);
  const sized = optimizeEntrySize({
    snap,
    tokenIn,
    tokenOut,
    expectedGrossPct: grossPct,
    minNetEdgePct: input.risk.minNetEdgePct,
    minIn: bounds.minIn,
    maxIn,
    volPerSec: realizedVolPerSec(series),
  });
  if (!sized) return null;
  const scored = scoreOpportunity({
    verdict: sized.best,
    confidence: thesis.confidence,
    minNetEdgePct: input.risk.minNetEdgePct,
    maxImpactPct: input.risk.maxImpactPct,
    quoteAgeMs: Math.max(0, opts.input.now - Date.parse(snap.fetchedAt)),
    maxQuoteAgeMs: Math.max(15, input.risk.maxQuoteAgeSec) * 1000,
  });
  const inv = inventoryFactor({
    balances: input.balances,
    quote: tokenIn,
    quoteUsd: bounds.quoteUsd,
    base: tokenOut,
    baseUsd: bounds.baseUsd,
    positionUsd: input.position ? input.position.amountLeef * bounds.baseUsd : 0,
    maxPositionUsd: input.risk.maxPositionUsd,
  });
  const route = sized.best.route;
  const opp = buildScoredOpportunity({
    strategy: opts.strategy,
    label: thesis.label,
    kind: "entry",
    tokenIn,
    tokenOut,
    amountIn: sized.best.amountIn,
    route,
    expectedGrossPct: grossPct,
    expectedNetProfitUsd: sized.best.netProfitUsd * inv * thesis.confidence,
    edge: {
      netEdgePct: sized.best.netEdgePct,
      netProfitUsd: sized.best.netProfitUsd,
      score: scored.score,
      explain: scored.explain,
    },
    complexity: routeComplexity(route),
    inventoryFit: inv,
    confidence: thesis.confidence,
    fingerprint: opportunityFingerprint({ kind: "entry", tokenIn, tokenOut, poolIds: route.poolIds }),
    gate,
  });
  return rejectOpportunity(opp) ? null : opp;
}

/** The Auto orchestrator: every strategy proposes, expected value decides. */
function decideAuto(input: BotInput, snap: LeefSnapshot, series: PricePoint[]): Decision {
  const bounds = boundsFor(input, snap);
  if ("error" in bounds) return { kind: "hold", reason: `Auto: ${bounds.error}` };
  const gateCtx = dangerGate(input, snap, series);
  if (gateCtx.blockReason) return { kind: "hold", reason: `Auto: ${gateCtx.blockReason}` };
  const gate: OpportunityGate = {
    regime: gateCtx.regime,
    dangerScore: gateCtx.danger,
    quoteAgeMs: Math.max(0, input.now - Date.parse(snap.fetchedAt)),
  };
  const candidates: ScoredOpportunity[] = [];
  const rejections: string[] = [];
  const consider = (opp: ScoredOpportunity | null, label: string) => {
    if (opp) candidates.push(opp);
    else rejections.push(label);
  };

  const signal = botSignal(series);
  if (signal.warmed && signal.bias === "buy") {
    consider(
      buildOpportunity({
        strategy: "signal",
        input, snap, bounds, series, gate, weight: gateCtx.weight,
        thesis: {
          grossPct: Math.max(0.5, input.goals.takeProfitPct * signal.confidence),
          confidence: signal.confidence,
          label: `Signal ${(signal.score * 100).toFixed(0)}%`,
        },
      }),
      "signal",
    );
  }

  const anchor = input.gridAnchor;
  if (anchor && snap.leefUsd > 0) {
    const dropPct = (anchor / snap.leefUsd - 1) * 100;
    if (dropPct >= input.risk.gridStepPct) {
      consider(
        buildOpportunity({
          strategy: "grid",
          input, snap, bounds, series, gate, weight: gateCtx.weight,
          thesis: {
            grossPct: input.risk.gridStepPct * 0.8,
            confidence: 0.6,
            label: `Grid step −${dropPct.toFixed(1)}%`,
          },
        }),
        "grid",
      );
    }
  }

  const mom = momentumPct(series, 6);
  if (mom <= -input.risk.gridStepPct) {
    consider(
      buildOpportunity({
        strategy: "meanrev",
        input, snap, bounds, series, gate, weight: gateCtx.weight,
        thesis: {
          grossPct: Math.abs(mom) * 0.7,
          confidence: 0.55,
          label: `Mean-rev ${mom.toFixed(1)}%`,
        },
      }),
      "meanrev",
    );
  }

  const arb = findBestArb(
    snap,
    Math.min(bounds.maxIn, (input.balances[input.quote ?? "WAX"] ?? 0)),
    input.risk.minEdgePct,
    false,
    bounds.minIn,
  );
  if (arb) {
    const waxUsd = snap.waxUsd;
    const netUsd = (arb.waxOut - arb.waxIn) * waxUsd;
    const opp = buildScoredOpportunity({
      strategy: "spread",
      label: `Arb #${arb.buyPool.id}→#${arb.sellPool.id} ${(arb.profitPct * 100).toFixed(2)}%`,
      kind: "arb",
      tokenIn: input.quote ?? "WAX",
      tokenOut: input.quote ?? "WAX",
      amountIn: arb.waxIn,
      route: null,
      arbPlan: arb,
      expectedGrossPct: arb.profitPct * 100,
      expectedNetProfitUsd: netUsd,
      edge: {
        netEdgePct: arb.profitPct * 100,
        netProfitUsd: netUsd,
        score: 90,
        explain: [`atomic profit ${(arb.profitPct * 100).toFixed(2)}% ≥ ${input.risk.minEdgePct}%`],
      },
      complexity: 2,
      inventoryFit: 1,
      confidence: 0.95,
      fingerprint: opportunityFingerprint({ kind: "arb", tokenIn: "WAX", tokenOut: "WAX", poolIds: [arb.buyPool.id, arb.sellPool.id] }),
      gate,
    });
    if (!rejectOpportunity(opp)) candidates.push(opp);
  }

  const next = planNextAction(snap, input.balances, {
    minUsd: bounds.minIn * bounds.quoteUsd,
    minNetPct: input.risk.minNetEdgePct,
    maxHops: input.risk.maxHops,
  });
  if (next) {
    const opp = buildScoredOpportunity({
      strategy: "auto",
      label: `Next hop ${next.tokenIn}→${next.tokenOut} ${next.netPct.toFixed(2)}%`,
      kind: "swap",
      tokenIn: next.tokenIn,
      tokenOut: next.tokenOut,
      amountIn: next.amountIn,
      route: next.route,
      expectedGrossPct: next.netPct,
      expectedNetProfitUsd: next.netUsd,
      edge: {
        netEdgePct: next.netPct,
        netProfitUsd: next.netUsd,
        score: 70,
        explain: [`${next.kind} net ${next.netPct.toFixed(2)}% after costs`],
      },
      complexity: routeComplexity(next.route),
      inventoryFit: 1,
      confidence: 0.7,
      fingerprint: opportunityFingerprint({
        kind: "swap",
        tokenIn: next.tokenIn,
        tokenOut: next.tokenOut,
        poolIds: next.route.poolIds,
      }),
      gate,
    });
    if (!rejectOpportunity(opp)) candidates.push(opp);
  }

  const winner = selectBestOpportunity(candidates);
  if (!winner) {
    return {
      kind: "hold",
      reason: `Auto scan: nothing clears net edge ${input.risk.minNetEdgePct}% (${rejections.join(", ") || "no candidates"}) — HOLD is a successful outcome`,
    };
  }
  if (winner.kind === "arb" && winner.arbPlan) {
    return {
      kind: "arb",
      plan: winner.arbPlan,
      arbKind: "spread",
      reason: `Auto: ${winner.label} · EV $${winner.expectedNetProfitUsd.toFixed(4)} · score ${winner.edge.score}`,
      opportunity: winner,
    };
  }
  if (winner.kind === "swap" && winner.route) {
    return {
      kind: "swap",
      tokenIn: winner.tokenIn,
      tokenOut: winner.tokenOut,
      amountIn: winner.amountIn,
      route: winner.route,
      minNetPct: input.risk.minNetEdgePct,
      reason: `Auto: ${winner.label} · EV $${winner.expectedNetProfitUsd.toFixed(4)} · score ${winner.edge.score}`,
      opportunity: winner,
    };
  }
  if (winner.route) {
    return {
      kind: "buy",
      amountWax: winner.amountIn,
      route: winner.route,
      confidence: winner.confidence,
      expectedGrossPct: winner.expectedGrossPct,
      edge: winner.edge,
      reason: `Auto: ${winner.label} · EV $${winner.expectedNetProfitUsd.toFixed(4)} · net ${winner.edge.netEdgePct.toFixed(2)}%`,
      opportunity: winner,
    };
  }
  return { kind: "hold", reason: "Auto scan: winner had no route" };
}

/** Unleashed: trade every cycle — mix strategies, clips and hops. */
function decideUnleashed(input: BotInput, snap: LeefSnapshot, series: PricePoint[]): Decision {
  const bounds = boundsFor(input, snap);
  if ("error" in bounds) return { kind: "hold", reason: `Unleashed: ${bounds.error}` };
  const gateCtx = dangerGate(input, snap, series);
  if (gateCtx.blockReason) return { kind: "hold", reason: `Unleashed: ${gateCtx.blockReason}` };

  const seed = input.now;
  const amount = pickClipInBand(bounds.minIn, bounds.maxIn * gateCtx.weight, seed);
  if (!(amount > 0)) return { kind: "hold", reason: "Unleashed: no deployable balance" };

  const spin = (Math.abs(Math.floor(seed / 1000)) >>> 0) % 5;
  const quote = input.quote ?? "WAX";
  const base = input.base ?? "LEEF";

  if (spin === 0) {
    const arb = findBestArb(snap, amount, input.risk.minEdgePct, false, bounds.minIn);
    if (arb) {
      return {
        kind: "arb",
        plan: arb,
        arbKind: "spread",
        reason: `Unleashed: arb #${arb.buyPool.id}→#${arb.sellPool.id} ${(arb.profitPct * 100).toFixed(2)}%`,
      };
    }
  }
  if (spin === 1) {
    const next = planNextAction(snap, input.balances, {
      minUsd: bounds.minIn * bounds.quoteUsd,
      minNetPct: input.risk.minNetEdgePct,
      maxHops: hopsForStrategy("unleashed", input.risk.maxHops),
    });
    if (next) {
      return {
        kind: "swap",
        tokenIn: next.tokenIn,
        tokenOut: next.tokenOut,
        amountIn: next.amountIn,
        route: next.route,
        minNetPct: input.risk.minNetEdgePct,
        reason: `Unleashed: next hop ${next.tokenIn}→${next.tokenOut} net ${next.netPct.toFixed(2)}%`,
      };
    }
  }
  if (spin === 2) {
    const tape = planLeefTape(snap, input.balances, {
      minUsd: bounds.minIn * bounds.quoteUsd,
      maxUsd: bounds.maxIn * bounds.quoteUsd,
      seed,
      maxLossPct: input.risk.maxEchoLossPct,
    });
    if (tape) {
      return {
        kind: "swap",
        tokenIn: tape.tokenIn,
        tokenOut: tape.tokenOut,
        amountIn: tape.amountIn,
        route: tape.route,
        minNetPct: -input.risk.maxEchoLossPct,
        reason: `Unleashed tape ${tape.tokenIn}→${tape.tokenOut} $${tape.usdIn.toFixed(2)} (${tape.netPct.toFixed(2)}%)`,
      };
    }
  }
  // Default: directional entry with the signal thesis if warmed, else momentum.
  const signal = botSignal(series);
  const mom = momentumPct(series, 6);
  const grossPct = signal.warmed
    ? Math.max(0.5, input.goals.takeProfitPct * signal.confidence)
    : Math.max(0.4, Math.abs(mom) * 0.7);
  const sized = optimizeEntrySize({
    snap,
    tokenIn: quote,
    tokenOut: base,
    expectedGrossPct: grossPct,
    minNetEdgePct: input.risk.minNetEdgePct,
    minIn: bounds.minIn,
    maxIn: Math.max(bounds.minIn, amount),
    volPerSec: realizedVolPerSec(series),
  });
  if (sized) {
    return {
      kind: "buy",
      amountWax: sized.best.amountIn,
      route: sized.best.route,
      confidence: signal.confidence || 0.5,
      expectedGrossPct: grossPct,
      edge: { netEdgePct: sized.best.netEdgePct, netProfitUsd: sized.best.netProfitUsd, score: 60 },
      reason: `Unleashed: ${quote}→${base} ${sized.best.amountIn.toFixed(2)} ${quote} · net ${sized.best.netEdgePct.toFixed(2)}%`,
    };
  }
  const echo = findBestArb(snap, amount, -input.risk.maxEchoLossPct, true, bounds.minIn);
  if (echo) {
    return {
      kind: "arb",
      plan: echo,
      arbKind: "volume",
      reason: `Unleashed: volume echo ${echo.waxIn.toFixed(2)} WAX (${(echo.profitPct * 100).toFixed(2)}%)`,
    };
  }
  return { kind: "hold", reason: "Unleashed: nothing executable this cycle" };
}

/* ------------------------------------------------------------------ */
/* Main entry                                                          */
/* ------------------------------------------------------------------ */

export function evaluateBot(input: BotInput): Decision {
  const { snap, series } = input;
  const quote = input.quote ?? "WAX";
  const base = input.base ?? "LEEF";
  const quoteUsd = usdPriceOf(quote, snap);
  const baseUsd = usdPriceOf(base, snap) || snap.leefUsd;

  // Forced manual clip (desk buttons).
  if (input.force === "sell") {
    const walletBase = balanceForIdentifier(input.balances, base, snap.universe);
    const held = Math.min(input.position?.amountLeef ?? Infinity, walletBase);
    if (!(held > 0)) return { kind: "hold", reason: `Force sell: no ${base} in the wallet` };
    const capped = input.position && held < input.position.amountLeef;
    const route = bestExecutionRoute(snap.pools, snap.aux, held, base, quote);
    if (!route) return { kind: "hold", reason: "Force sell: no executable route" };
    return {
      kind: "sell",
      amountLeef: held,
      route,
      confidence: 1,
      reason: capped ? `Force sell (capped at wallet balance ${held.toFixed(0)} ${base})` : "Force sell",
    };
  }
  if (input.force === "buy") {
    const bounds = boundsFor(input, snap);
    if ("error" in bounds) return { kind: "hold", reason: `Force buy: ${bounds.error}` };
    const amount = Math.min(bounds.maxIn, balanceForIdentifier(input.balances, quote, snap.universe));
    if (!(amount > 0)) return { kind: "hold", reason: `Force buy: no deployable ${quote}` };
    const route = bestExecutionRoute(snap.pools, snap.aux, amount, quote, base);
    if (!route) return { kind: "hold", reason: "Force buy: no executable route" };
    return {
      kind: "buy",
      amountWax: amount,
      route,
      confidence: 1,
      reason: `Force buy ${amount.toFixed(2)} ${quote}`,
    };
  }

  // Session guards.
  if (input.goals.sessionGoalUsd > 0 && input.sessionRealizedUsd >= input.goals.sessionGoalUsd) {
    return { kind: "stop", reason: `Session goal reached: +$${input.sessionRealizedUsd.toFixed(2)}` };
  }
  if (
    input.goals.maxDrawdownPct > 0 &&
    input.sessionStartEquityUsd > 0 &&
    input.sessionRealizedUsd <= (-input.goals.maxDrawdownPct / 100) * input.sessionStartEquityUsd
  ) {
    return {
      kind: "stop",
      reason: `Max drawdown hit: $${input.sessionRealizedUsd.toFixed(2)}`,
    };
  }
  if (input.now < input.cooldownUntil) {
    return { kind: "hold", reason: `Cooldown ${Math.ceil((input.cooldownUntil - input.now) / 1000)}s` };
  }
  if (input.tradesThisHour >= input.risk.maxTradesHour) {
    return { kind: "hold", reason: `Hourly cap ${input.risk.maxTradesHour} reached` };
  }
  const quoteAgeSec = (input.now - Date.parse(snap.fetchedAt)) / 1000;
  if (quoteAgeSec > Math.max(15, input.risk.maxQuoteAgeSec)) {
    return { kind: "hold", reason: `Book is ${quoteAgeSec.toFixed(0)}s old — waiting for a fresh one` };
  }

  // Position exits (all strategies with a position).
  if (input.position && input.position.amountLeef > 0) {
    const pos = input.position;
    const pnlPct = baseUsd > 0 && pos.entryUsd > 0 ? (baseUsd / pos.entryUsd - 1) * 100 : 0;
    const giveback = pos.highUsd > 0 ? (1 - baseUsd / pos.highUsd) * 100 : 0;
    const walletBase = balanceForIdentifier(input.balances, base, snap.universe);
    const sellable = Math.min(pos.amountLeef, walletBase);
    const sellRoute = sellable > 0 ? bestExecutionRoute(snap.pools, snap.aux, sellable, base, quote) : null;
    const sellDecision = (why: string): Decision =>
      sellable > 0 && sellRoute
        ? {
            kind: "sell",
            amountLeef: sellable,
            route: sellRoute,
            confidence: 0.9,
            reason: why + (sellable < pos.amountLeef ? " (capped at wallet balance)" : ""),
          }
        : { kind: "hold", reason: `${why} — but no sellable ${base}/route` };
    if (pnlPct >= input.goals.takeProfitPct) {
      return sellDecision(`Take-profit +${pnlPct.toFixed(1)}% ≥ ${input.goals.takeProfitPct}%`);
    }
    if (pnlPct <= -input.goals.stopLossPct) {
      return sellDecision(`Stop-loss ${pnlPct.toFixed(1)}% ≤ −${input.goals.stopLossPct}%`);
    }
    if (pnlPct >= input.goals.trailingPct && giveback >= input.goals.trailingPct) {
      return sellDecision(`Trailing stop: gave back ${giveback.toFixed(1)}% from the high`);
    }
    if (input.strategy === "signal") {
      const sig = botSignal(series);
      if (sig.warmed && sig.bias === "sell" && sig.confidence >= input.risk.minConfidence / 100) {
        return sellDecision(`Signal flipped bearish (${(sig.score * 100).toFixed(0)}%)`);
      }
    }
    if (input.strategy === "meanrev" && pos.entryUsd > 0 && baseUsd >= pos.entryUsd * 1.005) {
      return sellDecision(`Mean reversion complete (+${pnlPct.toFixed(1)}%)`);
    }
    if (input.strategy === "grid") {
      const anchor = input.gridAnchor ?? pos.entryUsd;
      if (anchor > 0 && baseUsd >= anchor * (1 + input.risk.gridStepPct / 100)) {
        return sellDecision(`Grid step up ${input.risk.gridStepPct}%`);
      }
    }
    if (input.strategy === "dca") {
      // DCA holds to take-profit/stop-loss only (handled above).
    }
    return { kind: "hold", reason: `Holding ${pos.amountLeef.toFixed(0)} ${base} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)` };
  }

  // Entry strategies.
  switch (input.strategy) {
    case "auto":
      return decideAuto(input, snap, series);
    case "unleashed":
      return decideUnleashed(input, snap, series);
    case "growth": {
      const targets = normalizeTargets(input.growthTargets ?? DEFAULT_GROWTH_TARGETS);
      const mode: GrowthMode = input.growthMode ?? "balanced";
      const bounds = boundsFor(input, snap);
      const plan = planGrowthAction(snap, input.balances, {
        targets,
        mode,
        minUsd: "error" in bounds ? 0 : bounds.minIn * bounds.quoteUsd,
        maxUsd: "error" in bounds ? 1 : bounds.maxIn * bounds.quoteUsd,
        maxHops: hopsForGrowth(mode, input.risk.maxHops),
        seed: input.now,
      });
      if ("hold" in plan) return { kind: "hold", reason: `Growth: ${plan.hold}` };
      return {
        kind: "swap",
        tokenIn: plan.tokenIn,
        tokenOut: plan.tokenOut,
        amountIn: plan.amountIn,
        route: plan.route,
        growthPlan: plan,
        minNetPct: -input.risk.maxEchoLossPct,
        reason: `Growth: ${plan.explain.join(" · ")}`,
      };
    }
    case "spread": {
      const bounds = boundsFor(input, snap);
      if ("error" in bounds) return { kind: "hold", reason: `Spread: ${bounds.error}` };
      const plan = findBestArb(
        snap,
        Math.min(bounds.maxIn, balanceForIdentifier(input.balances, quote, snap.universe)),
        input.risk.minEdgePct,
        false,
        bounds.minIn,
      );
      if (!plan) return { kind: "hold", reason: `No atomic spread ≥ ${input.risk.minEdgePct}%` };
      return {
        kind: "arb",
        plan,
        arbKind: "spread",
        reason: `Spread #${plan.buyPool.id}→#${plan.sellPool.id} ${(plan.profitPct * 100).toFixed(2)}%`,
      };
    }
    case "volume": {
      const bounds = boundsFor(input, snap);
      if ("error" in bounds) return { kind: "hold", reason: `Volume: ${bounds.error}` };
      const amount = pickClipInBand(bounds.minIn, bounds.maxIn, input.now);
      const plan = findBestArb(snap, amount, -input.risk.maxEchoLossPct, true, bounds.minIn);
      if (!plan) return { kind: "hold", reason: "No echo inside the loss budget" };
      return {
        kind: "arb",
        plan,
        arbKind: "volume",
        reason: `Volume echo ${plan.waxIn.toFixed(2)} WAX (${(plan.profitPct * 100).toFixed(2)}%)`,
      };
    }
    case "volume-x": {
      const bounds = boundsFor(input, snap);
      if ("error" in bounds) return { kind: "hold", reason: `Volume-X: ${bounds.error}` };
      const tape = planLeefTape(snap, input.balances, {
        minUsd: bounds.minIn * bounds.quoteUsd,
        maxUsd: bounds.maxIn * bounds.quoteUsd,
        seed: input.now,
        maxLossPct: input.risk.maxEchoLossPct,
        maxHops: hopsForStrategy("volume-x", input.risk.maxHops),
      });
      if (!tape) return { kind: "hold", reason: "Volume-X: no tape clip inside the loss budget" };
      return {
        kind: "swap",
        tokenIn: tape.tokenIn,
        tokenOut: tape.tokenOut,
        amountIn: tape.amountIn,
        route: tape.route,
        minNetPct: -input.risk.maxEchoLossPct,
        reason: `Volume-X ${tape.tokenIn}→${tape.tokenOut} $${tape.usdIn.toFixed(2)} (${tape.netPct.toFixed(2)}%)`,
      };
    }
    case "signal": {
      const gateCtx = dangerGate(input, snap, series);
      if (gateCtx.blockReason) return { kind: "hold", reason: gateCtx.blockReason };
      const sig = botSignal(series);
      if (!sig.warmed) return { kind: "hold", reason: `Signal warming up (${series.length}/${BOT_WARMUP_POINTS} prints)` };
      if (sig.bias !== "buy") return { kind: "hold", reason: `Signal ${sig.bias} (${(sig.score * 100).toFixed(0)}%)` };
      if (sig.confidence < input.risk.minConfidence / 100) {
        return { kind: "hold", reason: `Signal confidence ${(sig.confidence * 100).toFixed(0)}% < ${input.risk.minConfidence}%` };
      }
      const bounds = boundsFor(input, snap);
      if ("error" in bounds) return { kind: "hold", reason: `Signal: ${bounds.error}` };
      const grossPct = Math.max(0.5, input.goals.takeProfitPct * sig.confidence);
      const sized = optimizeEntrySize({
        snap,
        tokenIn: quote,
        tokenOut: base,
        expectedGrossPct: grossPct,
        minNetEdgePct: input.risk.minNetEdgePct,
        minIn: bounds.minIn,
        maxIn: bounds.maxIn * gateCtx.weight,
        volPerSec: realizedVolPerSec(series),
      });
      if (!sized) return { kind: "hold", reason: "Signal buy clears net edge at no size" };
      return {
        kind: "buy",
        amountWax: sized.best.amountIn,
        route: sized.best.route,
        confidence: sig.confidence,
        expectedGrossPct: grossPct,
        edge: { netEdgePct: sized.best.netEdgePct, netProfitUsd: sized.best.netProfitUsd, score: 75 },
        reason: `Signal buy ${(sig.score * 100).toFixed(0)}% · net ${sized.best.netEdgePct.toFixed(2)}%`,
      };
    }
    case "meanrev": {
      const gateCtx = dangerGate(input, snap, series);
      if (gateCtx.blockReason) return { kind: "hold", reason: gateCtx.blockReason };
      const mom = momentumPct(series, 6);
      if (mom > -input.risk.gridStepPct) return { kind: "hold", reason: `Mean-rev: momentum ${mom.toFixed(1)}% not stretched` };
      const bounds = boundsFor(input, snap);
      if ("error" in bounds) return { kind: "hold", reason: `Mean-rev: ${bounds.error}` };
      const grossPct = Math.abs(mom) * 0.7;
      const sized = optimizeEntrySize({
        snap,
        tokenIn: quote,
        tokenOut: base,
        expectedGrossPct: grossPct,
        minNetEdgePct: input.risk.minNetEdgePct,
        minIn: bounds.minIn,
        maxIn: bounds.maxIn * gateCtx.weight,
        volPerSec: realizedVolPerSec(series),
      });
      if (!sized) return { kind: "hold", reason: "Mean-rev clears net edge at no size" };
      return {
        kind: "buy",
        amountWax: sized.best.amountIn,
        route: sized.best.route,
        confidence: 0.55,
        expectedGrossPct: grossPct,
        edge: { netEdgePct: sized.best.netEdgePct, netProfitUsd: sized.best.netProfitUsd, score: 65 },
        reason: `Mean-rev buy ${mom.toFixed(1)}% stretch · net ${sized.best.netEdgePct.toFixed(2)}%`,
      };
    }
    case "grid": {
      const bounds = boundsFor(input, snap);
      if ("error" in bounds) return { kind: "hold", reason: `Grid: ${bounds.error}` };
      const anchor = input.gridAnchor;
      if (!anchor || !(anchor > 0) || !(baseUsd > 0)) {
        return { kind: "hold", reason: "Grid: no anchor yet" };
      }
      const dropPct = (anchor / baseUsd - 1) * 100;
      if (dropPct < input.risk.gridStepPct) {
        return { kind: "hold", reason: `Grid: ${dropPct.toFixed(1)}% below anchor < ${input.risk.gridStepPct}% step` };
      }
      const grossPct = input.risk.gridStepPct * 0.8;
      const sized = optimizeEntrySize({
        snap,
        tokenIn: quote,
        tokenOut: base,
        expectedGrossPct: grossPct,
        minNetEdgePct: input.risk.minNetEdgePct,
        minIn: bounds.minIn,
        maxIn: bounds.maxIn,
        volPerSec: realizedVolPerSec(series),
      });
      if (!sized) return { kind: "hold", reason: "Grid step clears net edge at no size" };
      return {
        kind: "buy",
        amountWax: sized.best.amountIn,
        route: sized.best.route,
        confidence: 0.6,
        expectedGrossPct: grossPct,
        edge: { netEdgePct: sized.best.netEdgePct, netProfitUsd: sized.best.netProfitUsd, score: 65 },
        reason: `Grid step −${dropPct.toFixed(1)}% · net ${sized.best.netEdgePct.toFixed(2)}%`,
      };
    }
    case "dca": {
      const bounds = boundsFor(input, snap);
      if ("error" in bounds) return { kind: "hold", reason: `DCA: ${bounds.error}` };
      const grossPct = input.goals.takeProfitPct;
      const sized = optimizeEntrySize({
        snap,
        tokenIn: quote,
        tokenOut: base,
        expectedGrossPct: grossPct,
        minNetEdgePct: input.risk.minNetEdgePct,
        minIn: bounds.minIn,
        maxIn: bounds.maxIn,
        volPerSec: realizedVolPerSec(series),
      });
      if (!sized) return { kind: "hold", reason: "DCA clip clears net edge at no size" };
      return {
        kind: "buy",
        amountWax: sized.best.amountIn,
        route: sized.best.route,
        confidence: 0.5,
        expectedGrossPct: grossPct,
        edge: { netEdgePct: sized.best.netEdgePct, netProfitUsd: sized.best.netProfitUsd, score: 55 },
        reason: `DCA accumulate · net ${sized.best.netEdgePct.toFixed(2)}%`,
      };
    }
    default:
      return { kind: "hold", reason: `Unknown strategy ${input.strategy}` };
  }
}

/** Portfolio USD mark — used by the desk header. */
export function equityUsd(snap: LeefSnapshot, balances: Record<string, number>): number {
  return markPortfolioUsd(snap, balances).totalUsd;
}

/** Exported for the desk's pool-focus picker. */
export { backedPools, isLeefToken, isWaxToken, virtualLeefPairReserves };
