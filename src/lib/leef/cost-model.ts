/**
 * TradeCostModel — the single authoritative economic calculation.
 *
 * Every strategy's proposal flows through here before capital moves. The
 * model answers one question: "after ALL realistic costs, is this trade
 * economically better than doing nothing?"
 *
 * What it charges a WAX→LEEF→WAX style round trip:
 *
 *   execInPct    — spot→fill gap of the ENTRY route, measured as
 *                  1 − actualOut / idealOut where idealOut converts at the
 *                  book's USD mid prices. This captures AMM fee + price
 *                  impact exactly once (the constant-product quote already
 *                  nets both into amountOut — we never re-add a fee on top).
 *   execOutPct   — same measure for the expected EXIT route, so an entry is
 *                  judged on the full round trip, not just the cheap side.
 *   slippagePct  — fixed uncertainty allowance for reserve drift between
 *                  quote and fill (the on-chain min-out guard is the hard
 *                  limit; this is the EXPECTED cost, not the limit).
 *   decayPct     — opportunity decay: realized per-second volatility × the
 *                  expected quote→confirm latency × decaySigma. A signal on a
 *                  fast-moving book decays faster than the tx confirms.
 *   resourceUsd  — WAX CPU/NET cost per transaction (≈ 0 for well-staked
 *                  accounts; configurable for renters).
 *   failureUsd   — failureProb × resourceUsd: reverted txs still burn CPU.
 *
 * Nothing here is a magic threshold — every number is either measured from
 * the current book/series or a documented, configurable CostConfig value.
 */
import type { LeefSnapshot, SwapRoute } from "./types";
import { PLATFORM_FEE_PCT } from "./platform-fee";
import { tokenPrice } from "@/lib/market/price-oracle";

export type CostConfig = {
  /** Estimated WAX CPU/NET cost of one transaction, USD. ≈0 when staked. */
  txCostUsd: number;
  /** Probability a broadcast reverts (still burns the resource cost). */
  failureProb: number;
  /** Fixed slippage allowance for reserve drift between quote and fill, %. */
  slippageBufferPct: number;
  /** Expected quote→confirm latency, seconds. */
  latencySec: number;
  /** Fraction of 1σ price drift over the latency window assumed adverse. */
  decaySigma: number;
  /**
   * Platform fee per executed trade, percent of the guaranteed output
   * (0.001% = "0.001"). A round trip pays it on entry AND exit.
   */
  platformFeePct: number;
};

/**
 * WAX micropayments: a staked account pays no transfer fee (CPU/NET/RAM
 * regenerate). Charging $0.002/tx made a $0.0000001 clip look like −2000%
 * and silenced volume. Renters can still pass txCostUsd > 0.
 *
 * Remaining costs are real: LP fee + impact (inside the quote), a thin
 * slippage buffer, and opportunity decay. Reverts still cost CPU time but
 * not dollars when staked.
 */
export const DEFAULT_COSTS: CostConfig = {
  txCostUsd: 0,
  failureProb: 0.03,
  slippageBufferPct: 0.05,
  latencySec: 4,
  decaySigma: 1,
  platformFeePct: PLATFORM_FEE_PCT,
};

export type CostBreakdown = {
  execInPct: number;
  execOutPct: number;
  slippagePct: number;
  decayPct: number;
  resourceUsd: number;
  failureUsd: number;
  /** All percentage costs summed (entry + exit + slippage + decay). */
  totalPct: number;
  /** Fixed USD costs summed (resource + failure). */
  fixedUsd: number;
};

/**
 * USD mark from the authoritative price oracle. A bare symbol resolves only
 * when unambiguous; economic callers should pass SYMBOL@CONTRACT or Alcor id.
 */
export function usdPriceOf(identifier: string, snap: LeefSnapshot): number {
  const s = identifier.toUpperCase();
  if (s === "WAX") return snap.waxUsd;
  if (s === "LEEF") return snap.leefUsd;
  return tokenPrice(snap, identifier)?.priceUsd ?? 0;
}

/**
 * Exact spot→fill cost of a route, percent of notional: the gap between the
 * fill the quote math delivers and a frictionless conversion at USD mids.
 * Fee + impact are both inside `route.amountOut`, so this counts them once.
 */
export function executionCostPct(
  route: SwapRoute,
  snap: LeefSnapshot,
): number {
  const inUsd = usdPriceOf(route.tokenIn, snap);
  const outUsd = usdPriceOf(route.tokenOut, snap);
  if (!(inUsd > 0) || !(outUsd > 0) || !(route.amountIn > 0)) return 0;
  const idealOut = (route.amountIn * inUsd) / outUsd;
  if (!(idealOut > 0)) return 0;
  return Math.max(0, (1 - route.amountOut / idealOut) * 100);
}

/**
 * Realized volatility of the bot's own print series, per second.
 * Returns 0 until enough prints exist (callers then charge zero decay).
 */
export function realizedVolPerSec(
  series: { t: number; usd: number }[],
  maxPoints = 60,
): number {
  const pts = series.slice(-maxPoints);
  if (pts.length < 3) return 0;
  const rets: number[] = [];
  let dtSum = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (a.usd > 0 && b.usd > 0 && b.t > a.t) {
      rets.push(b.usd / a.usd - 1);
      dtSum += (b.t - a.t) / 1000;
    }
  }
  const n = rets.length;
  if (n < 2 || dtSum <= 0) return 0;
  const m = rets.reduce((s, r) => s + r, 0) / n;
  const variance = rets.reduce((s, r) => s + (r - m) * (r - m), 0) / (n - 1);
  const secPerTick = dtSum / n;
  return secPerTick > 0 ? Math.sqrt(variance) / Math.sqrt(secPerTick) : Math.sqrt(variance);
}

/**
 * Full round-trip cost of entering `route` and later exiting the position
 * back through `exitRoute` (falling back to entry symmetry when no exit
 * route is quotable — documented conservative choice).
 */
export function estimateRoundTripCosts(opts: {
  route: SwapRoute;
  exitRoute: SwapRoute | null;
  snap: LeefSnapshot;
  volPerSec: number;
  config?: Partial<CostConfig>;
}): CostBreakdown {
  const cfg: CostConfig = { ...DEFAULT_COSTS, ...(opts.config ?? {}) };
  const execInPct = executionCostPct(opts.route, opts.snap);
  const execOutPct = opts.exitRoute
    ? executionCostPct(opts.exitRoute, opts.snap)
    : execInPct;
  const slippagePct = Math.max(0, cfg.slippageBufferPct);
  const decayPct = Math.max(0, opts.volPerSec * cfg.latencySec * cfg.decaySigma * 100);
  const resourceUsd = Math.max(0, cfg.txCostUsd) * 2; // entry + exit
  const failureUsd = cfg.failureProb * cfg.txCostUsd * 2;
  // Platform fee: charged on the guaranteed output of entry AND exit.
  const platformFeePct = Math.max(0, cfg.platformFeePct) * 2;
  return {
    execInPct,
    execOutPct,
    slippagePct,
    decayPct,
    resourceUsd,
    failureUsd,
    totalPct: execInPct + execOutPct + slippagePct + decayPct + platformFeePct,
    fixedUsd: resourceUsd + failureUsd,
  };
}
