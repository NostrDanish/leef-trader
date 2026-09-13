import { backedPools, isLeefToken, isWaxToken, quoteConstantProduct } from "./amm";
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
} from "./risk-usd";
import type { LeefPool, LeefSnapshot, SwapRoute } from "./types";
import {
  buildScoredOpportunity,
  calibrationHaircut,
  inventoryFactor,
  opportunityFingerprint,
  rejectOpportunity,
  routeComplexity,
  routeHops,
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
  minNetEdgePct: 0,
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

/**
 * Adaptive grid step: large enough to clear a round-trip of fees + impact
 * plus recent realized volatility. Never below 1% or above 8%.
 */
export function adaptiveGridStepPct(
  configured: number,
  volPerSec: number,
  feePct = 0.3,
): number {
  const roundTripFee = feePct * 2;
  const vol30s = volPerSec * 30 * 100; // percent move over one print
  const floor = roundTripFee + 0.4; // fees plus a thin impact/slippage buffer
  return Math.min(8, Math.max(1, configured, floor, vol30s * 1.5));
}

/** Latest RSI, Bollinger %B and distance to the band midline from the real series. */
export function reversionRead(series: PricePoint[]): {
  rsi: number | null;
  pctB: number | null;
  /** Distance from current price up to the Bollinger midline, percent. */
  distToMidPct: number | null;
} {
  if (series.length < BOT_WARMUP_POINTS) return { rsi: null, pctB: null, distToMidPct: null };
  const points = decorate(seriesToCandles(series), BOT_TICK_PARAMS);
  const last = points[points.length - 1];
  const distToMidPct =
    last && last.bbMid != null && last.c > 0 ? (last.bbMid / last.c - 1) * 100 : null;
  return { rsi: last?.rsi ?? null, pctB: last?.pctB ?? null, distToMidPct };
}

/**
 * Adaptive cooldown: arb/echo round trips are self-contained and can re-arm
 * faster; DCA is deliberately slow; a losing trade slows the bot down
  * (simple anti-tilt, never a martingale). The 10s floor matches the Live
  * book pull — no configuration may trade faster than that.
  */
export function adaptiveCooldownSec(
  baseSec: number,
  strategy: BotStrategy,
  lastPnlUsd: number,
): number {
  let factor = 1;
  if (
    strategy === "spread" ||
    strategy === "volume" ||
    strategy === "volume-x" ||
    strategy === "unleashed"
  )
    factor = 0.5;
  else if (strategy === "growth") factor = 0.75;
  else if (strategy === "dca") factor = 2;
  if (lastPnlUsd < 0) factor *= 1.5;
  return Math.max(10, Math.round(baseSec * factor));
}

/** Pick a clip inside [min, max] — never always the max. Mix dust / mid / fat. */
export function pickClipInBand(minIn: number, maxIn: number, seed = Date.now()): number {
  if (!(maxIn > 0) || maxIn + 1e-12 < minIn) return 0;
  if (maxIn - minIn < minIn * 0.02) return maxIn;
  const r = ((seed * 1_103_515_245 + 12_345) >>> 0) / 4_294_967_296;
  const ladder = [0, 0.08, 0.18, 0.35, 0.55, 0.8, 1];
  const f = ladder[Math.floor(r * ladder.length) % ladder.length]!;
  return minIn + (maxIn - minIn) * f;
}

/** Strategy-aware hop budget: never above the user cap, not always 10. */
export function hopsForStrategy(strategy: BotStrategy, cap: number, seed = Date.now()): number {
  const c = Math.min(10, Math.max(1, Math.floor(cap || 4)));
  const r = ((seed >>> 0) % 3) + 1;
  if (strategy === "spread" || strategy === "volume") return Math.min(c, 2);
  if (strategy === "volume-x" || strategy === "unleashed")
    return Math.min(c, Math.max(2, r + 1));
  if (strategy === "growth") return hopsForGrowth("balanced", c);
  if (strategy === "signal" || strategy === "meanrev") return Math.min(c, 3);
  return Math.min(c, 4);
}

function bestBuyRoute(
  snap: LeefSnapshot,
  amountIn: number,
  quote = "WAX",
  base = "LEEF",
): SwapRoute | null {
  if (amountIn <= 0) return null;
  return bestExecutionRoute(snap.pools, snap.aux, amountIn, quote, base);
}

function bestSellRoute(
  snap: LeefSnapshot,
  baseAmount: number,
  quote = "WAX",
  base = "LEEF",
): SwapRoute | null {
  if (baseAmount <= 0) return null;
  return bestExecutionRoute(snap.pools, snap.aux, baseAmount, base, quote);
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
/** LEEF/WAX books from Defibox/Taco, shaped as LeefPool so arb can cross venues. */
function venueWaxLeefPools(snap: LeefSnapshot): LeefPool[] {
  const out: LeefPool[] = [];
  for (const p of snap.aux) {
    if (p.venue !== "defibox" && p.venue !== "taco") continue;
    const wax = isWaxToken(p.tokenA) ? p.tokenA : isWaxToken(p.tokenB) ? p.tokenB : null;
    const leef = isLeefToken(p.tokenA) ? p.tokenA : isLeefToken(p.tokenB) ? p.tokenB : null;
    if (!wax || !leef || leef.quantity < 1_000_000) continue;
    out.push({
      id: p.id,
      fee: p.fee,
      feePct: p.feePct,
      leef,
      pair: wax,
      leefIsA: isLeefToken(p.tokenA),
      tvlUsd: p.tvlUsd,
      volume24Usd: p.volume24Usd,
      volumeWeekUsd: 0,
      volumeUsdMonth: 0,
      volumeUsd90: 0,
      volumeLeef24: 0,
      volumePair24: 0,
      change24: 0,
      changeWeek: 0,
      liquidity: "0",
      pairPerLeef: leef.quantity > 0 ? wax.quantity / leef.quantity : 0,
      leefPerPair: wax.quantity > 0 ? leef.quantity / wax.quantity : 0,
      waxPerLeef: leef.quantity > 0 ? wax.quantity / leef.quantity : null,
      usdPerLeef: null,
      tickSpacing: 60,
    });
  }
  return out;
}

export function findArb(
  snap: LeefSnapshot,
  waxIn: number,
  minProfitPct: number,
  allowSamePool = false,
): ArbPlan | null {
  if (!(waxIn > 0)) return null;
  const waxPools = [
    ...backedPools(snap.pools).filter((p) => isWaxToken(p.pair)),
    ...venueWaxLeefPools(snap),
  ];
  if (waxPools.length < 2 && !allowSamePool) return null;

  let best: ArbPlan | null = null;
  for (const buyPool of waxPools) {
    const q1 = quoteConstantProduct(waxIn, buyPool.pair.quantity, buyPool.leef.quantity, buyPool.fee);
    if (q1.amountOut <= 0 || q1.priceImpact > 0.2) continue;
    for (const sellPool of waxPools) {
      if (!allowSamePool && sellPool.id === buyPool.id) continue;
      const q2 = quoteConstantProduct(q1.amountOut, sellPool.leef.quantity, sellPool.pair.quantity, sellPool.fee);
      if (q2.amountOut <= 0 || q2.priceImpact > 0.2) continue;
      const profitPct = q2.amountOut / waxIn - 1;
      const impactPct = 1 - (1 - q1.priceImpact) * (1 - q2.priceImpact);
      // Rank by net WAX profit, not percentage — a 2 WAX clip at +0.8% can
      // beat a 10 WAX clip at +0.3% after impact.
      const profitWax = q2.amountOut - waxIn;
      const bestProfit = best ? best.waxOut - best.waxIn : -Infinity;
      if (profitPct * 100 >= minProfitPct && profitWax > bestProfit) {
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
  return best;
}

/** Scan a size ladder and pick the clip that maximises net WAX profit. */
export function findBestArb(
  snap: LeefSnapshot,
  maxWax: number,
  minProfitPct: number,
  allowSamePool = false,
  minWax = 0,
): ArbPlan | null {
  if (!(maxWax > 0) || maxWax + 1e-12 < minWax) return null;
  const floor = Math.max(0, minWax);
  let best: ArbPlan | null = null;
  const span = maxWax - floor;
  const points = span < floor * 0.02 ? [floor, maxWax] : [0, 0.2, 0.35, 0.6, 1].map((f) => floor + span * f);
  for (const size of points) {
    const plan = findArb(snap, size, minProfitPct, allowSamePool);
    if (!plan) continue;
    if (!best || plan.waxOut - plan.waxIn > best.waxOut - best.waxIn) best = plan;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* The decision engine                                                 */
/* ------------------------------------------------------------------ */

function hold(reason: string): Decision {
  return { kind: "hold", reason };
}

function gateFromRisk(risk: BotRisk): OpportunityGate {
  return {
    minNetProfitUsd: 0,
    minNetEdgePct: Math.max(0, risk.minNetEdgePct),
    minExecutionProbability: 0.35,
    maxImpactPct: risk.maxImpactPct,
    maxQuoteAgeMs: Math.max(1, risk.maxQuoteAgeSec) * 1000,
    maxVolumeCostPct: risk.maxEchoLossPct,
  };
}

function scoreBuyOpportunity(opts: {
  source: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  notionalUsd: number;
  netProfitUsd: number;
  netEdgePct: number;
  route: SwapRoute;
  quoteAgeMs: number;
  maxQuoteAgeMs: number;
  snap: LeefSnapshot;
  balances: Record<string, number>;
  calibration?: CalibrationMemory;
  strategyConfidence: number;
}): ScoredOpportunity {
  return buildScoredOpportunity({
    fingerprint: opportunityFingerprint({
      kind: opts.source,
      tokenIn: opts.tokenIn,
      tokenOut: opts.tokenOut,
      routeId: opts.route.id,
    }),
    intent: "profit",
    source: opts.source,
    tokenIn: opts.tokenIn,
    tokenOut: opts.tokenOut,
    amountIn: opts.amountIn,
    notionalUsd: opts.notionalUsd,
    expectedNetProfitUsd: opts.netProfitUsd,
    expectedNetEdgePct: opts.netEdgePct,
    hops: routeComplexity(opts.route).hops,
    liquidityUsd: opts.route.tvlUsd,
    impactPct: opts.route.priceImpact * 100,
    split: opts.route.kind === "split",
    actions: routeComplexity(opts.route).actions,
    quoteAgeMs: opts.quoteAgeMs,
    maxQuoteAgeMs: opts.maxQuoteAgeMs,
    inventoryFactor: inventoryFactor({
      snap: opts.snap,
      balances: opts.balances,
      tokenOut: opts.tokenOut,
    }),
    calibrationHaircut: calibrationHaircut(opts.calibration),
    strategyConfidence: opts.strategyConfidence,
  });
}

function scoreArbOpportunity(opts: {
  source: string;
  intent: "profit" | "volume";
  plan: ArbPlan;
  waxUsd: number;
  quoteAgeMs: number;
  maxQuoteAgeMs: number;
  snap: LeefSnapshot;
  balances: Record<string, number>;
  calibration?: CalibrationMemory;
}): ScoredOpportunity {
  const netUsd = (opts.plan.waxOut - opts.plan.waxIn) * opts.waxUsd;
  // Atomic two-leg in ONE transaction — hop count is the worse leg, not the sum.
  const hops = Math.max(
    opts.plan.buyLegs?.reduce((m, l) => Math.max(m, l.route.length), 1) ?? 1,
    opts.plan.sellLegs?.reduce((m, l) => Math.max(m, l.route.length), 1) ?? 1,
  );
  const actions =
    (opts.plan.buyLegs?.length ?? 1) + (opts.plan.sellLegs?.length ?? 1);
  const tvl = Math.min(opts.plan.buyPool.tvlUsd, opts.plan.sellPool.tvlUsd);
  return buildScoredOpportunity({
    fingerprint: opportunityFingerprint({
      kind: opts.source,
      tokenIn: "WAX",
      tokenOut: "WAX",
      routeId: `${opts.plan.buyPool.id}>${opts.plan.sellPool.id}`,
    }),
    intent: opts.intent,
    source: opts.source,
    tokenIn: "WAX",
    tokenOut: "WAX",
    amountIn: opts.plan.waxIn,
    notionalUsd: opts.plan.waxIn * opts.waxUsd,
    expectedNetProfitUsd: netUsd,
    expectedNetEdgePct: opts.plan.profitPct * 100,
    hops,
    actions,
    split: actions > 2,
    liquidityUsd: tvl,
    impactPct: opts.plan.impactPct * 100,
    quoteAgeMs: opts.quoteAgeMs,
    maxQuoteAgeMs: opts.maxQuoteAgeMs,
    inventoryFactor: 1, // round-trip: inventory-neutral
    calibrationHaircut: calibrationHaircut(opts.calibration),
    strategyConfidence: 0.85,
  });
}

export function evaluateBot(input: BotInput): Decision {
  const { snap, risk, goals, position, strategy } = input;
  const now = input.now;
  const quote = (input.quote ?? "WAX").toUpperCase();
  const base = (input.base ?? "LEEF").toUpperCase();
  const leefUsd = snap.leefUsd;
  const waxUsd = snap.waxUsd;
  /** USD mark of the asset being accumulated — generic, not LEEF-hardcoded. */
  const baseUsd = usdPriceOf(base, snap) > 0 ? usdPriceOf(base, snap) : leefUsd;

  if (!input.running && !input.force) return hold("Bot is stopped");
  if (snap.source !== "live") return hold("Book is stale — waiting for live Alcor data");
  if (!(leefUsd > 0) || !(waxUsd > 0)) return hold("Waiting for a priced book");
  if (!(baseUsd > 0)) return hold(`No USD mark for ${base} — pick another base token`);
  if (quote !== "WAX" && !(usdPriceOf(quote, snap) > 0)) {
    return hold(`No USD mark for ${quote} — pick another quote token`);
  }

  // Quote freshness: never act on an obsolete book. Callers raise
  // maxQuoteAgeSec with the current sync cadence (syncSec + one miss).
  const quoteAgeSec = (now - Date.parse(snap.fetchedAt)) / 1000;
  if (!Number.isFinite(quoteAgeSec) || quoteAgeSec > risk.maxQuoteAgeSec) {
    return hold(
      `Book quote is ${Number.isFinite(quoteAgeSec) ? `${Math.round(quoteAgeSec)}s` : "unparseably"} old — waiting for a fresh pull`,
    );
  }

  // Session goal / drawdown circuit breakers.
  if (goals.sessionGoalUsd > 0 && input.sessionRealizedUsd >= goals.sessionGoalUsd) {
    return {
      kind: "stop",
      reason: `Session goal reached (+$${input.sessionRealizedUsd.toFixed(2)} realized) — bot stopped`,
    };
  }
  const equityUsd = markPortfolioUsd(snap, input.balances).totalUsd;
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

  /* ------------------------- manual overrides ---------------------- */

  const bounds = usdToTokenBounds({
    snap,
    quote,
    base,
    risk,
    position: input.position,
    balances: input.balances,
  });
  // Treasure growth is inventory-agnostic — a missing quote mark must not
  // block converting TLM/USDC/… into the named treasures.
  if ("error" in bounds && strategy !== "growth") return hold(bounds.error);
  const minWax = "error" in bounds ? 0 : bounds.minIn;
  const maxWax = "error" in bounds ? 0 : bounds.maxIn;

  if (input.force === "buy") {
    if (maxWax + 1e-12 < minWax) {
      return hold(
        `Effective max $${bounds.effectiveMaxUsd.toFixed(2)} is under min trade $${risk.minTradeUsd.toFixed(2)} (wallet $${bounds.walletUsd.toFixed(2)}) — sitting out`,
      );
    }
    const sized = optimizeEntrySize({
      snap,
      tokenIn: quote,
      tokenOut: base,
      expectedGrossPct: Math.max(goals.takeProfitPct, 0.5),
      minNetEdgePct: 0,
      minIn: minWax,
      maxIn: maxWax,
      volPerSec: realizedVolPerSec(input.series),
    });
    if (!sized) {
      return hold(
        `Manual buy · no size in $${risk.minTradeUsd.toFixed(2)}–$${bounds.effectiveMaxUsd.toFixed(2)} effective max clears costs — sitting out`,
      );
    }
    const route = sized.best.route;
    const amountWax = sized.best.amountIn;
    return {
      kind: "buy",
      amountWax,
      route,
      reason: `Manual buy · ${amountWax.toFixed(2)} ${quote} ($${risk.minTradeUsd.toFixed(2)}–$${risk.maxPositionUsd.toFixed(0)}) · ${route.label}`,
      confidence: signal.confidence,
      expectedGrossPct: Math.max(goals.takeProfitPct, 0.5),
      edge: sized
        ? { netEdgePct: sized.best.netEdgePct, netProfitUsd: sized.best.netProfitUsd, score: 0 }
        : undefined,
    };
  }
  if (input.force === "sell" && (!position || position.amountLeef <= 0)) {
    return hold("No open position to sell");
  }

  /* ----------- position-independent scans (spread arb / volume) ---- */

  const quoteAgeMs = quoteAgeSec * 1000;
  const maxQuoteAgeMs = risk.maxQuoteAgeSec * 1000;
  const oppGate = gateFromRisk(risk);
  const calOf = (id: string) => input.calibration?.[id];

  if (strategy === "volume-x") {
    const hops = hopsForStrategy("volume-x", risk.maxHops, now);
    const tape = planLeefTape(snap, input.balances, {
      minUsd: risk.minTradeUsd,
      maxUsd: Math.max(risk.minTradeUsd, bounds.effectiveMaxUsd || risk.maxPositionUsd),
      maxHops: hops,
      seed: now,
      maxLossPct: risk.maxEchoLossPct,
    });
    if (tape) {
      const scored = scoreBuyOpportunity({
        source: "volume-x",
        tokenIn: tape.tokenIn,
        tokenOut: tape.tokenOut,
        amountIn: tape.amountIn,
        notionalUsd: tape.usdIn,
        netProfitUsd: tape.netUsd,
        netEdgePct: tape.netPct,
        route: tape.route,
        quoteAgeMs,
        maxQuoteAgeMs,
        snap,
        balances: input.balances,
        calibration: calOf("volume-x"),
        strategyConfidence: 1,
      });
      return {
        kind: "swap",
        tokenIn: tape.tokenIn,
        tokenOut: tape.tokenOut,
        amountIn: tape.amountIn,
        route: tape.route,
        opportunity: scored,
        reason: `Volume-X ${tape.tokenIn}→${tape.tokenOut} · $${tape.usdIn.toFixed(4)} · net ${tape.netPct.toFixed(2)}% · ${tape.route.label}`,
      };
    }
    if (!position || position.amountLeef <= 0) {
      return hold("Volume-X: no LEEF-tape clip inside min–max from this wallet");
    }
  }

  if (strategy === "spread" || strategy === "volume") {
    const waxAvail = maxWax;
    const isVolume = strategy === "volume";
    let arbDecision: Decision | null = null;
    let scanReason: string;

    if (waxAvail + 1e-12 < minWax) {
      scanReason = `Not enough ${quote} for the $${risk.minTradeUsd.toFixed(2)} min trade`;
    } else if (isVolume) {
      const clip = pickClipInBand(minWax, waxAvail, now);
      const plan = findBestArb(snap, clip > 0 ? clip : waxAvail, -risk.maxEchoLossPct, true, minWax);
      if (plan) {
        const scored = scoreArbOpportunity({
          source: "volume",
          // Stay volume even if the echo is slightly green — promoting it to
          // "profit" used to demand 0.1% edge and killed zero-loss volume.
          intent: "volume",
          plan,
          waxUsd,
          quoteAgeMs,
          maxQuoteAgeMs,
          snap,
          balances: input.balances,
          calibration: calOf("volume"),
        });
        const why = rejectOpportunity(scored, oppGate);
        if (why) {
          scanReason = `Volume rejected by common gate: ${why} · EV $${scored.expectedValueUsd.toFixed(4)}`;
        } else {
          const costPct = -plan.profitPct * 100;
          arbDecision = {
            kind: "arb",
            arbKind: "volume",
            plan,
            opportunity: scored,
            reason:
              plan.profitPct >= 0
                ? `Spread-funded echo #${plan.buyPool.id}→#${plan.sellPool.id} · EV $${scored.expectedValueUsd.toFixed(4)} · exec ${(scored.executionProbability * 100).toFixed(0)}%`
                : `Volume echo #${plan.buyPool.id}${plan.sellPool.id === plan.buyPool.id ? " round-trip" : `→#${plan.sellPool.id}`} · cost ${costPct.toFixed(2)}% · EV $${scored.expectedValueUsd.toFixed(4)}`,
          };
        }
      } else {
        scanReason = `Round trip costs more than the ${risk.maxEchoLossPct}% budget right now`;
      }
    } else {
      const gatePct =
        ((1 + risk.minEdgePct / 100) / Math.max(0.9, 1 - risk.slippage / 100) - 1) * 100;
      const plan = findBestArb(snap, waxAvail, gatePct, false, minWax);
      if (plan) {
        const scored = scoreArbOpportunity({
          source: "spread",
          intent: "profit",
          plan,
          waxUsd,
          quoteAgeMs,
          maxQuoteAgeMs,
          snap,
          balances: input.balances,
          calibration: calOf("spread"),
        });
        const why = rejectOpportunity(scored, oppGate);
        if (why) {
          scanReason = `Arb rejected by common gate: ${why} · EV $${scored.expectedValueUsd.toFixed(4)} · ${scored.explain[1]}`;
        } else {
          arbDecision = {
            kind: "arb",
            arbKind: "spread",
            plan,
            opportunity: scored,
            reason: `Arb #${plan.buyPool.id}→#${plan.sellPool.id} · EV $${scored.expectedValueUsd.toFixed(4)} · net ${(plan.profitPct * 100).toFixed(2)}% · exec ${(scored.executionProbability * 100).toFixed(0)}%`,
          };
        }
      } else {
        const probe = findBestArb(snap, waxAvail, -100, false, minWax);
        scanReason = `No atomic arb ≥ ${risk.minEdgePct}% after fees+impact (${
          probe ? `best spread ${(probe.profitPct * 100).toFixed(2)}%` : "no two WAX books"
        })`;
      }
    }

    if (arbDecision) return arbDecision;
    if (!position || position.amountLeef <= 0) return hold(scanReason!);
  }

  /* ------------------- entry sizing (NetEdgeEngine) ---------------- */

  /**
   * Entries flow through the NetEdgeEngine: scan sizes below the risk cap,
   * charge the full round-trip cost model, and take the profit-maximizing
   * size that still clears minNetEdgePct. No size clears → DO NOTHING.
   * (Exits are never edge-gated — risk actions must always fire.)
   */
  const tryBuyWith = (
    reason: string,
    expectedGrossPct: number,
    confidence: number,
    maxWaxArg: number,
  ): Decision => {
    if (!(maxWaxArg > 0) || maxWaxArg + 1e-12 < minWax) {
      return hold(
        `Position cap reached ($${bounds.positionUsd.toFixed(2)} / $${risk.maxPositionUsd.toFixed(0)}), remaining room under min trade, or no ${quote}`,
      );
    }
    if (!(expectedGrossPct > 0)) return hold("No positive expected move on this book — sitting out");
    const sized = optimizeEntrySize({
      snap,
      tokenIn: quote,
      tokenOut: base,
      expectedGrossPct,
      minNetEdgePct: risk.minNetEdgePct,
      minIn: minWax,
      maxIn: maxWaxArg,
      volPerSec: realizedVolPerSec(input.series),
    });
    if (!sized) {
      return hold(
        `No size in ${minWax.toFixed(2)}–${maxWaxArg.toFixed(2)} ${quote} clears net edge ≥ ${risk.minNetEdgePct}% after all costs`,
      );
    }
    const v = sized.best;
    if (v.route.priceImpact * 100 > risk.maxImpactPct) {
      return hold(
        `Entry impact ${(v.route.priceImpact * 100).toFixed(1)}% above ${risk.maxImpactPct}% cap`,
      );
    }
    const score = scoreOpportunity({
      verdict: v,
      confidence,
      minNetEdgePct: risk.minNetEdgePct,
      maxImpactPct: risk.maxImpactPct,
      quoteAgeMs,
      maxQuoteAgeMs,
    });
    const scored = scoreBuyOpportunity({
      source: strategy,
      tokenIn: quote,
      tokenOut: base,
      amountIn: v.amountIn,
      notionalUsd: v.notionalUsd,
      netProfitUsd: v.netProfitUsd,
      netEdgePct: v.netEdgePct,
      route: v.route,
      quoteAgeMs,
      maxQuoteAgeMs,
      snap,
      balances: input.balances,
      calibration: calOf(strategy === "auto" ? "signal" : strategy),
      strategyConfidence: confidence,
    });
    const why = rejectOpportunity(scored, oppGate);
    if (why) {
      return hold(
        `${reason} rejected by common gate: ${why} · EV $${scored.expectedValueUsd.toFixed(4)} · ${scored.explain[1]}`,
      );
    }
    return {
      kind: "buy",
      amountWax: v.amountIn,
      route: v.route,
      reason:
        `${reason} · EV $${scored.expectedValueUsd.toFixed(4)} · net ${v.netEdgePct.toFixed(2)}% ≈ $${v.netProfitUsd.toFixed(3)} ` +
        `on ${v.amountIn.toFixed(2)} ${quote} · exec ${(scored.executionProbability * 100).toFixed(0)}%`,
      confidence,
      expectedGrossPct,
      edge: { netEdgePct: v.netEdgePct, netProfitUsd: v.netProfitUsd, score: score.score },
      opportunity: scored,
    };
  };
  const tryBuy = (reason: string, expectedGrossPct: number, confidence: number): Decision =>
    tryBuyWith(reason, expectedGrossPct, confidence, maxWax);

  /* ---------------- position management (pair strategies) ---------- */

  if (position && position.amountLeef > 0 && strategy !== "growth") {
    const pnlPct = (baseUsd / position.entryUsd - 1) * 100;
    // Chain truth beats local tracking: never build a transfer for more base
    // than the wallet actually holds — that tx reverts with overdrawn balance.
    const walletBase = balanceForIdentifier(input.balances, snap.universe, base);
    const sellableBase = Math.min(position.amountLeef, Math.max(0, walletBase));
    const sellRoute = bestSellRoute(snap, sellableBase, quote, base);

    const sellAll = (reason: string): Decision | null => {
      if (!(sellableBase > 0)) {
        return hold(
          `Position tracks ${position.amountLeef.toLocaleString()} ${base} but the wallet holds ${walletBase.toLocaleString()} — nothing sellable on-chain`,
        );
      }
      if (!sellRoute) return null;
      if (sellRoute.priceImpact * 100 > risk.maxImpactPct) {
        return hold(`Exit impact ${(sellRoute.priceImpact * 100).toFixed(1)}% above cap — waiting for depth`);
      }
      const cappedNote =
        sellableBase + 1e-9 < position.amountLeef
          ? ` (capped at wallet balance ${walletBase.toLocaleString()} ${base})`
          : "";
      return {
        kind: "sell",
        amountLeef: sellableBase,
        route: sellRoute,
        reason: reason + cappedNote,
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
      const givebackPct = (baseUsd / position.highUsd - 1) * 100;
      if (peakPct >= goals.trailingPct && givebackPct <= -goals.trailingPct) {
        const d = sellAll(
          `Trailing stop · peaked +${peakPct.toFixed(1)}%, gave back ${givebackPct.toFixed(1)}% — locking +${pnlPct.toFixed(2)}%`,
        );
        if (d) return d;
      }
    }

    // Strategy exits. Auto inherits every exit rule.
    if ((strategy === "signal" || strategy === "auto") && signal.warmed && signal.bias === "sell") {
      const d = sellAll(
        `Engine vote flipped sell (${Math.round(signal.confidence * 100)}% conf) · position ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
      );
      if (d) return d;
    }
    if (strategy === "meanrev" || strategy === "auto") {
      const { rsi, pctB } = reversionRead(input.series);
      if (rsi != null && pctB != null && (rsi >= 62 || pctB >= 0.9)) {
        const d = sellAll(
          `Reversion exit · RSI ${rsi.toFixed(0)} / %B ${pctB.toFixed(2)} back at the mean · position ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
        );
        if (d) return d;
      }
    }
    if ((strategy === "grid" || strategy === "auto") && input.gridAnchor != null) {
      const step = adaptiveGridStepPct(risk.gridStepPct, realizedVolPerSec(input.series));
      const stepUp = input.gridAnchor * (1 + step / 100);
      if (baseUsd >= stepUp) {
        const d = sellAll(
          `Grid step +${step.toFixed(2)}% filled · ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% on the leg`,
        );
        if (d) return d;
      }
    }
    if (strategy === "auto") {
      // With a position open, the only position-independent action worth
      // considering is atomic arbitrage — it doesn't touch the held bag.
      if (maxWax + 1e-12 >= minWax) {
        const gatePct =
          ((1 + risk.minEdgePct / 100) / Math.max(0.9, 1 - risk.slippage / 100) - 1) * 100;
        const arb = findBestArb(snap, maxWax, gatePct, false, minWax);
        if (arb) {
          const opp = scoreArbOpportunity({
            source: "spread",
            intent: "profit",
            plan: arb,
            waxUsd,
            quoteAgeMs,
            maxQuoteAgeMs,
            snap,
            balances: input.balances,
            calibration: calOf("spread"),
          });
          const why = rejectOpportunity(opp, oppGate);
          if (!why && opp.expectedValueUsd > 0) {
            return {
              kind: "arb",
              arbKind: "spread",
              plan: arb,
              opportunity: opp,
              reason: `Auto: arb #${arb.buyPool.id}→#${arb.sellPool.id} beats holding · EV $${opp.expectedValueUsd.toFixed(4)} · exec ${(opp.executionProbability * 100).toFixed(0)}%`,
            };
          }
        }
      }
    }
    if (strategy === "dca") {
      // Keep stacking until the position cap, then ride to the take-profit.
      // maxWax already is min(spendable wallet, remaining position headroom)
      // in quote units — never read a bare-symbol balance here.
      const dcaMax = maxWax;
      if (dcaMax + 1e-12 >= minWax) {
        return tryBuyWith(
          `DCA clip · averaging in at $${baseUsd.toFixed(8)}/${base}`,
          goals.takeProfitPct,
          signal.confidence,
          dcaMax,
        );
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

  switch (strategy) {
    case "signal": {
      if (!signal.warmed) {
        return hold(`Engines warming up — ${input.series.length}/${BOT_WARMUP_POINTS} prints collected`);
      }
      const conf = Math.round(signal.confidence * 100);
      const mom = momentumPct(input.series);
      if (signal.bias === "buy" && conf >= risk.minConfidence) {
        const votes = signal.readings
          .filter((r) => r.score > 0.12)
          .map((r) => r.id.toUpperCase())
          .join("+");
        // Thesis size = TP faded by momentum, NOT by vote confidence.
        // Confidence already gated entry (minConfidence). Multiplying it into
        // expected gross AND again into EV double-counted the same number.
        const expected = goals.takeProfitPct * (mom < 0 ? 0.6 : 1);
        return tryBuy(
          `Engine vote BUY ${conf}% conf (${votes || "blend"}) · momentum ${(mom * 100).toFixed(2)}%`,
          expected,
          1,
        );
      }
      return hold(`Vote ${signal.bias} · ${conf}% conf (need ≥ ${risk.minConfidence}% buy)`);
    }
    case "meanrev": {
      const { rsi, pctB, distToMidPct } = reversionRead(input.series);
      if (rsi == null || pctB == null) {
        return hold(`Engines warming up — ${input.series.length}/${BOT_WARMUP_POINTS} prints collected`);
      }
      const mom = momentumPct(input.series, 12);
      // Do not catch a falling knife: a strong downtrend is not a dip.
      if (mom < -0.04) {
        return hold(`Mean-reversion blocked — 12-print momentum ${(mom * 100).toFixed(1)}% (trend, not a dip)`);
      }
      if (rsi <= 30 && pctB <= 0.1) {
        const expected = Math.max(0, (distToMidPct ?? 0) * 0.7);
        return tryBuy(
          `Oversold · RSI ${rsi.toFixed(0)} ≤ 30, %B ${pctB.toFixed(2)} at the lower band`,
          expected,
          signal.confidence,
        );
      }
      return hold(`RSI ${rsi.toFixed(0)} · %B ${pctB.toFixed(2)} — waiting for an oversold tag`);
    }
    case "grid": {
      const step = adaptiveGridStepPct(risk.gridStepPct, realizedVolPerSec(input.series));
      const expected = step * 0.8;
      const anchor = input.gridAnchor;
      if (anchor == null) {
        return tryBuy(`Grid seed buy — anchoring at market · step ${step.toFixed(2)}%`, expected, signal.confidence);
      }
      const stepDown = anchor * (1 - step / 100);
      if (baseUsd <= stepDown) {
        return tryBuy(`Grid step −${step.toFixed(2)}% filled at the bid`, expected, signal.confidence);
      }
      const distDown = (baseUsd / stepDown - 1) * 100;
      return hold(`Grid armed · next buy ${distDown.toFixed(1)}% below, next sell +${step.toFixed(2)}% above last fill`);
    }
    case "dca": {
      const mom = momentumPct(input.series, 8);
      // Skip a clip when the tape is ripping against us; size stays risk-capped.
      if (mom > 0.05) {
        return hold(`DCA waiting — 8-print momentum +${(mom * 100).toFixed(1)}% (not averaging into a spike)`);
      }
      return tryBuy("Scheduled accumulation clip", goals.takeProfitPct, signal.confidence);
    }
    case "auto": {
      /* Auto is the orchestrator, not a private economist. Each strategy
       * produces a ScoredOpportunity through the SAME gate; Auto ranks by
       * expected value (net × exec × fresh × inventory × calibration). */
      const considered: string[] = [];
      const scored: ScoredOpportunity[] = [];
      const byFp = new Map<string, Decision>();

      const pushScored = (d: Decision) => {
        if ((d.kind === "buy" || d.kind === "arb" || d.kind === "swap") && d.opportunity) {
          scored.push(d.opportunity);
          byFp.set(d.opportunity.fingerprint, d);
          considered.push(`${d.opportunity.source} EV $${d.opportunity.expectedValueUsd.toFixed(4)}`);
        } else if (d.kind === "hold") {
          considered.push(d.reason.slice(0, 80));
        }
      };

      if (maxWax + 1e-12 >= minWax) {
        const gatePct =
          ((1 + risk.minEdgePct / 100) / Math.max(0.9, 1 - risk.slippage / 100) - 1) * 100;
        const arb = findBestArb(snap, maxWax, gatePct, false, minWax);
        if (arb) {
          const opp = scoreArbOpportunity({
            source: "spread",
            intent: "profit",
            plan: arb,
            waxUsd,
            quoteAgeMs,
            maxQuoteAgeMs,
            snap,
            balances: input.balances,
            calibration: calOf("spread"),
          });
          const why = rejectOpportunity(opp, oppGate);
          if (why) {
            considered.push(`arb ${why}`);
          } else {
            scored.push(opp);
            byFp.set(opp.fingerprint, {
              kind: "arb",
              arbKind: "spread",
              plan: arb,
              opportunity: opp,
              reason: `Auto: arb #${arb.buyPool.id}→#${arb.sellPool.id} · EV $${opp.expectedValueUsd.toFixed(4)} · exec ${(opp.executionProbability * 100).toFixed(0)}%`,
            });
            considered.push(`arb EV $${opp.expectedValueUsd.toFixed(4)}`);
          }
        } else {
          const probe = findBestArb(snap, maxWax, -100, false, minWax);
          considered.push(
            probe
              ? `best arb ${(probe.profitPct * 100).toFixed(2)}% < ${risk.minEdgePct}% gate`
              : "no two WAX books",
          );
        }
      } else {
        considered.push(
          `no deployable ${quote} (effective max $${bounds.effectiveMaxUsd.toFixed(2)} < min $${risk.minTradeUsd.toFixed(2)})`,
        );
      }

      const theses: { reason: string; expected: number; confidence: number }[] = [];
      if (signal.warmed && signal.bias === "buy" && Math.round(signal.confidence * 100) >= risk.minConfidence) {
        const mom = momentumPct(input.series);
        theses.push({
          reason: `Auto: engine vote BUY ${Math.round(signal.confidence * 100)}% conf`,
          expected: goals.takeProfitPct * (mom < 0 ? 0.6 : 1),
          confidence: 1,
        });
      } else if (!signal.warmed) {
        considered.push(`engines warming up ${input.series.length}/${BOT_WARMUP_POINTS}`);
      }
      {
        const { rsi, pctB, distToMidPct } = reversionRead(input.series);
        if (rsi != null && pctB != null && momentumPct(input.series, 12) >= -0.04 && rsi <= 30 && pctB <= 0.1) {
          theses.push({
            reason: `Auto: oversold RSI ${rsi.toFixed(0)} / %B ${pctB.toFixed(2)}`,
            expected: Math.max(0, (distToMidPct ?? 0) * 0.7),
            confidence: 1,
          });
        }
      }
      {
        const step = adaptiveGridStepPct(risk.gridStepPct, realizedVolPerSec(input.series));
        const anchor = input.gridAnchor;
        if (anchor == null || baseUsd <= anchor * (1 - step / 100)) {
          theses.push({
            reason: `Auto: grid step −${step.toFixed(2)}% zone`,
            expected: step * 0.8,
            confidence: 1,
          });
        }
      }
      for (const t of theses) pushScored(tryBuyWith(t.reason, t.expected, t.confidence, maxWax));

      // Holdings-based next hop: whatever we actually hold → best one-shot
      // swap or cycle. HOLD if nothing clears. Never continues a stale path.
      {
        const next = planNextAction(snap, input.balances, {
          minUsd: risk.minTradeUsd,
          minNetPct: Math.max(0, risk.minNetEdgePct),
          maxHops: 4,
        });
        if (next) {
          const scoredNext = scoreBuyOpportunity({
            source: next.kind === "cycle" ? "cycle" : "path",
            tokenIn: next.tokenIn,
            tokenOut: next.tokenOut,
            amountIn: next.amountIn,
            notionalUsd: next.usdIn,
            netProfitUsd: next.netUsd,
            netEdgePct: next.netPct,
            route: next.route,
            quoteAgeMs,
            maxQuoteAgeMs,
            snap,
            balances: input.balances,
            calibration: calOf("auto"),
            strategyConfidence: 1,
          });
          const why = rejectOpportunity(scoredNext, oppGate);
          if (why) {
            considered.push(`next-action ${why}`);
          } else {
            scored.push(scoredNext);
            byFp.set(scoredNext.fingerprint, {
              kind: "swap",
              tokenIn: next.tokenIn,
              tokenOut: next.tokenOut,
              amountIn: next.amountIn,
              route: next.route,
              opportunity: scoredNext,
              reason: `Auto: ${next.kind} ${next.tokenIn}→${next.tokenOut} · EV $${scoredNext.expectedValueUsd.toFixed(4)} · net ${next.netPct.toFixed(2)}%`,
            });
            considered.push(`${next.kind} ${next.tokenIn}→${next.tokenOut} EV $${scoredNext.expectedValueUsd.toFixed(4)}`);
          }
        } else {
          considered.push("no profitable next hop from holdings — HOLD is valid");
        }
      }

      const { winner, rejected } = selectBestOpportunity(scored, oppGate, now);
      if (winner && winner.intent === "profit" && winner.expectedValueUsd > 0) {
        const d = byFp.get(winner.fingerprint);
        if (d) return d;
      }
      for (const r of rejected) considered.push(`${r.reason}`);

      // Controlled volume ONLY when nothing profitable exists. Same common
      // gate — never "there is a trade, therefore trade."
      if (risk.maxEchoLossPct > 0 && maxWax + 1e-12 >= minWax) {
        const echo = findBestArb(snap, maxWax, -risk.maxEchoLossPct, true, minWax);
        if (echo) {
          const opp = scoreArbOpportunity({
            source: "volume",
            intent: "volume",
            plan: echo,
            waxUsd,
            quoteAgeMs,
            maxQuoteAgeMs,
            snap,
            balances: input.balances,
            calibration: calOf("volume"),
          });
          const why = rejectOpportunity(opp, oppGate);
          if (why) {
            considered.push(`volume ${why}`);
          } else {
            const costUsd = Math.max(0, echo.waxIn - echo.waxOut) * waxUsd;
            return {
              kind: "arb",
              arbKind: "volume",
              plan: echo,
              opportunity: opp,
              reason: `Auto: no profitable action — volume echo #${echo.buyPool.id}${
                echo.sellPool.id === echo.buyPool.id ? " round-trip" : `→#${echo.sellPool.id}`
              } · cost $${costUsd.toFixed(3)} · exec ${(opp.executionProbability * 100).toFixed(0)}%`,
            };
          }
        }
      }
      return hold(`Auto scan: ${considered.join(" · ") || "nothing in range"} — waiting`);
    }
    case "unleashed": {
      const hops = hopsForStrategy("unleashed", risk.maxHops, now);
      const mix: Decision[] = [];
      if (maxWax + 1e-12 >= minWax) {
        const clip = pickClipInBand(minWax, maxWax, now);
        const gatePct =
          ((1 + Math.max(0, risk.minEdgePct) / 100) / Math.max(0.9, 1 - risk.slippage / 100) - 1) * 100;
        const arb = findBestArb(snap, clip > 0 ? clip : maxWax, Math.min(gatePct, 0), false, minWax);
        if (arb) {
          mix.push({
            kind: "arb",
            arbKind: "spread",
            plan: arb,
            reason: `Unleashed arb #${arb.buyPool.id}→#${arb.sellPool.id} · ${(arb.profitPct * 100).toFixed(2)}%`,
          });
        }
        const echo = findBestArb(snap, clip > 0 ? clip : maxWax, -risk.maxEchoLossPct, true, minWax);
        if (echo) {
          mix.push({
            kind: "arb",
            arbKind: "volume",
            plan: echo,
            reason: `Unleashed echo #${echo.buyPool.id} · clip ${clip.toFixed(4)} ${quote}`,
          });
        }
      }
      const tape = planLeefTape(snap, input.balances, {
        minUsd: risk.minTradeUsd,
        maxUsd: Math.max(risk.minTradeUsd, bounds.effectiveMaxUsd),
        maxHops: hops,
        seed: now + 17,
        maxLossPct: risk.maxEchoLossPct,
      });
      if (tape) {
        mix.push({
          kind: "swap",
          tokenIn: tape.tokenIn,
          tokenOut: tape.tokenOut,
          amountIn: tape.amountIn,
          route: tape.route,
          reason: `Unleashed tape ${tape.tokenIn}→${tape.tokenOut} · $${tape.usdIn.toFixed(4)}`,
        });
      }
      const next = planNextAction(snap, input.balances, {
        minUsd: risk.minTradeUsd,
        minNetPct: -risk.maxEchoLossPct,
        maxHops: hops,
      });
      if (next) {
        mix.push({
          kind: "swap",
          tokenIn: next.tokenIn,
          tokenOut: next.tokenOut,
          amountIn: next.amountIn,
          route: next.route,
          reason: `Unleashed ${next.kind} ${next.tokenIn}→${next.tokenOut} · ${next.netPct.toFixed(2)}%`,
        });
      }
      if (signal.warmed && signal.bias === "buy") {
        mix.push(tryBuyWith("Unleashed signal", goals.takeProfitPct, 1, maxWax));
      }
      const { rsi, pctB, distToMidPct } = reversionRead(input.series);
      if (rsi != null && pctB != null && rsi <= 40) {
        mix.push(
          tryBuyWith(
            "Unleashed meanrev",
            Math.max(0.2, (distToMidPct ?? 1) * 0.5),
            1,
            maxWax,
          ),
        );
      }
      const actionable = mix.filter((d) => d.kind !== "hold");
      if (actionable.length === 0) {
        return hold("Unleashed: wallet or book cannot trade this cycle");
      }
      const pick = actionable[(now >>> 0) % actionable.length]!;
      return pick;
    }
    case "growth": {
      const mode = input.growthMode ?? "balanced";
      const hops = hopsForGrowth(mode, risk.maxHops);
      const ageMs = now - Date.parse(snap.fetchedAt);
      // Cap per holding inside the growth engine — do not bind to the quote-token
      // wallet (the treasure might be bought with TLM/USDC while WAX is empty).
      const maxUsd = Math.max(risk.minTradeUsd, risk.maxPositionUsd);
      const planned = planGrowthAction(snap, input.balances, {
        targets: normalizeTargets(input.growthTargets ?? DEFAULT_GROWTH_TARGETS),
        mode,
        minUsd: risk.minTradeUsd,
        maxUsd,
        maxHops: hops,
        seed: now,
        quoteAgeMs: Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0,
        maxQuoteAgeMs: risk.maxQuoteAgeSec * 1000,
      });
      if ("hold" in planned) return hold(planned.explain.join(" · "));
      return {
        kind: "swap",
        tokenIn: planned.tokenIn,
        tokenOut: planned.tokenOut,
        amountIn: planned.amountIn,
        route: planned.route,
        reason: planned.explain.join(" · "),
        growthPlan: planned,
      };
    }
    case "spread":
    case "volume":
    case "volume-x":
      return hold("Scan only");
  }
}
