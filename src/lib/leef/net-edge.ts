/**
 * NetEdgeEngine — the mathematical brain between "strategy has a signal" and
 * "capital moves".
 *
 * A strategy proposes a direction and an expected gross move. This engine
 * answers, with the book's own math:
 *
 *   1. OPTIMAL SIZE — scans candidate sizes and picks the one that maximizes
 *      expected NET profit (gross scales with size; price impact grows with
 *      size; net profit is concave → there is an interior maximum, and it is
 *      usually smaller than the configured clip).
 *
 *   2. NET EDGE — expectedGrossPct minus the full round-trip cost from the
 *      TradeCostModel, in percent of notional, plus the fixed USD costs.
 *
 *   3. OPPORTUNITY SCORE — an explainable 0–100 product of factors, each
 *      reported so a rejection can say WHY ("net edge 0.18% < required
 *      0.35%"), not merely "score 42".
 *
 * If nothing clears the required net edge, the engine returns null and the
 * bot does nothing. Doing nothing is a successful trading decision.
 */
import { compareAllRoutes } from "./amm";
import {
  estimateRoundTripCosts,
  usdPriceOf,
  type CostBreakdown,
  type CostConfig,
} from "./cost-model";
import type { LeefSnapshot, SwapRoute } from "./types";

export type EdgeVerdict = {
  route: SwapRoute;
  exitRoute: SwapRoute | null;
  amountIn: number;
  notionalUsd: number;
  expectedGrossPct: number;
  grossProfitUsd: number;
  costs: CostBreakdown;
  totalCostUsd: number;
  netProfitUsd: number;
  netEdgePct: number;
  pass: boolean;
  reason: string;
};

/** Evaluate one candidate size end-to-end. Null = no backed route at all. */
export function evaluateEntry(opts: {
  snap: LeefSnapshot;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  /** Strategy-anchored expected gross move of the position, percent. */
  expectedGrossPct: number;
  /** Required clearance above all costs, percent of notional. */
  minNetEdgePct: number;
  volPerSec: number;
  costs?: Partial<CostConfig>;
}): EdgeVerdict | null {
  const route = compareAllRoutes(
    opts.snap.pools,
    opts.snap.aux,
    opts.amountIn,
    opts.tokenIn,
    opts.tokenOut,
  )[0];
  if (!route) return null;

  // The exit route for the position we'd hold — judged at the size we'd exit.
  const exitRoute =
    compareAllRoutes(
      opts.snap.pools,
      opts.snap.aux,
      route.amountOut,
      opts.tokenOut,
      opts.tokenIn,
    )[0] ?? null;

  const costs = estimateRoundTripCosts({
    route,
    exitRoute,
    snap: opts.snap,
    volPerSec: opts.volPerSec,
    config: opts.costs,
  });

  const inUsd = usdPriceOf(opts.tokenIn, opts.snap);
  const notionalUsd = opts.amountIn * inUsd;
  if (!(notionalUsd > 0)) return null;

  const grossProfitUsd = (notionalUsd * opts.expectedGrossPct) / 100;
  const totalCostUsd = (notionalUsd * costs.totalPct) / 100 + costs.fixedUsd;
  const netProfitUsd = grossProfitUsd - totalCostUsd;
  const netEdgePct =
    opts.expectedGrossPct - costs.totalPct - (costs.fixedUsd / notionalUsd) * 100;
  const pass = netEdgePct >= opts.minNetEdgePct && netProfitUsd > 0;

  const reason = pass
    ? `net edge ${netEdgePct.toFixed(2)}% ≥ ${opts.minNetEdgePct}% after ` +
      `${costs.totalPct.toFixed(2)}% costs (in ${costs.execInPct.toFixed(2)} / out ${costs.execOutPct.toFixed(2)} / slip ${costs.slippagePct.toFixed(2)} / decay ${costs.decayPct.toFixed(2)}) + $${costs.fixedUsd.toFixed(4)} fixed`
    : `net edge ${netEdgePct.toFixed(2)}% < required ${opts.minNetEdgePct}% after ` +
      `${costs.totalPct.toFixed(2)}% costs + $${costs.fixedUsd.toFixed(4)} fixed on $${notionalUsd.toFixed(2)}`;

  return {
    route,
    exitRoute,
    amountIn: opts.amountIn,
    notionalUsd,
    expectedGrossPct: opts.expectedGrossPct,
    grossProfitUsd,
    costs,
    totalCostUsd,
    netProfitUsd,
    netEdgePct,
    pass,
    reason,
  };
}

/** Candidate ladder: fractions of the risk-capped maximum size. */
const SIZE_LADDER = [1, 0.75, 0.5, 0.3, 0.15, 0.08];

export type SizedEntry = {
  best: EdgeVerdict;
  /** Every candidate's outcome — feeds explainability and the shadow log. */
  tried: { amountIn: number; netEdgePct: number; netProfitUsd: number }[];
};

/**
 * Profit-maximizing size for an entry. Scans the ladder below the risk cap
 * and returns the candidate with the highest expected NET profit that still
 * clears the required net edge. Null when NO size is worth trading — the
 * correct answer on a thin or quiet book.
 */
export function optimizeEntrySize(opts: {
  snap: LeefSnapshot;
  tokenIn: string;
  tokenOut: string;
  expectedGrossPct: number;
  minNetEdgePct: number;
  /** Risk-capped maximum input (clip ∧ balance ∧ position room). */
  maxIn: number;
  volPerSec: number;
  costs?: Partial<CostConfig>;
}): SizedEntry | null {
  if (!(opts.maxIn > 0)) return null;
  const tried: SizedEntry["tried"] = [];
  let best: EdgeVerdict | null = null;
  const seen = new Set<number>();

  for (const f of SIZE_LADDER) {
    const amountIn = opts.maxIn * f;
    // Skip dust candidates and duplicate rounded sizes.
    const key = Math.round(amountIn * 1e6);
    if (!(amountIn > 0) || seen.has(key)) continue;
    seen.add(key);
    const v = evaluateEntry({ ...opts, amountIn });
    if (!v) continue;
    tried.push({ amountIn, netEdgePct: v.netEdgePct, netProfitUsd: v.netProfitUsd });
    if (v.pass && (!best || v.netProfitUsd > best.netProfitUsd)) best = v;
  }
  if (!best) return null;
  return { best, tried };
}

/* ------------------------------------------------------------------ */
/* Opportunity score — explainable by construction                     */
/* ------------------------------------------------------------------ */

export type OpportunityScore = {
  score: number;
  factors: {
    edge: number;
    execution: number;
    liquidity: number;
    confidence: number;
    freshness: number;
  };
  /** Human-readable factor lines, e.g. "edge 0.83% (4.2× required)". */
  explain: string[];
};

/** TVL at which liquidity stops being the binding constraint for micro clips. */
export const SCORE_LIQUIDITY_REF_USD = 10_000;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function scoreOpportunity(opts: {
  verdict: EdgeVerdict;
  /** Strategy confidence 0–1. */
  confidence: number;
  minNetEdgePct: number;
  maxImpactPct: number;
  quoteAgeMs: number;
  maxQuoteAgeMs: number;
}): OpportunityScore {
  const v = opts.verdict;
  const edge = clamp01(v.netEdgePct / Math.max(opts.minNetEdgePct * 4, 0.01));
  const execution = clamp01(1 - v.costs.execInPct / Math.max(opts.maxImpactPct, 0.01));
  const liquidity = clamp01(v.route.tvlUsd / SCORE_LIQUIDITY_REF_USD);
  const confidence = clamp01(opts.confidence);
  const freshness = clamp01(1 - opts.quoteAgeMs / Math.max(opts.maxQuoteAgeMs, 1));
  const score = Math.round(100 * edge * execution * liquidity * confidence * freshness);
  return {
    score,
    factors: { edge, execution, liquidity, confidence, freshness },
    explain: [
      `edge ${v.netEdgePct.toFixed(2)}% (${(v.netEdgePct / Math.max(opts.minNetEdgePct, 0.01)).toFixed(1)}× required)`,
      `execution cost ${v.costs.execInPct.toFixed(2)}% of ${opts.maxImpactPct}% cap`,
      `liquidity $${v.route.tvlUsd.toFixed(0)} TVL`,
      `confidence ${(confidence * 100).toFixed(0)}%`,
      `quote age ${(opts.quoteAgeMs / 1000).toFixed(1)}s`,
    ],
  };
}
