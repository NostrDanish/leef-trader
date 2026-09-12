/**
 * Common trading brain. Strategies propose intent; this module decides
 * whether a proposal is worth scarce capital RIGHT NOW.
 *
 * Auto is not a second economist — it is the orchestrator that ranks
 * opportunities every other strategy already ran through here.
 *
 * Ranking key is expected VALUE, not headline percent:
 *
 *   expectedNetProfitUsd
 *     × executionProbability
 *     × freshnessFactor
 *     × inventoryFactor
 *     × calibrationHaircut
 *
 * A +1.8% 3-hop thin-pool clip loses to a +0.9% 1-hop deep clip when the
 * product of confidence is higher. Doing nothing is a valid winner.
 */
import type { LeefSnapshot, SwapRoute } from "./types";
import { DEFAULT_GOVERNOR, portfolioState } from "@/lib/market/portfolio-governor";
import type { BalanceBook } from "@/lib/wallet/balances";

/** Minimal calibration memory — matches store/bot StrategyPerf fields we need. */
export type CalibrationMemory = {
  trades: number;
  predEdgePctSum: number;
  realEdgePctSum: number;
};

export type OpportunityIntent = "profit" | "rebalance" | "volume";

export type ScoredOpportunity = {
  fingerprint: string;
  intent: OpportunityIntent;
  source: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  notionalUsd: number;
  expectedNetProfitUsd: number;
  expectedNetEdgePct: number;
  hops: number;
  liquidityUsd: number;
  impactPct: number;
  executionProbability: number;
  freshnessFactor: number;
  inventoryFactor: number;
  calibrationHaircut: number;
  strategyConfidence: number;
  /** Ranking key — USD expected value after haircuts. */
  expectedValueUsd: number;
  /** 0–100 explainability, never the ranking key. */
  score: number;
  explain: string[];
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function routeHops(route: SwapRoute | null | undefined): number {
  if (!route) return 1;
  if (route.kind === "direct") return 1;
  if (route.kind === "split") return Math.max(1, ...route.legs.map(() => 1));
  return Math.max(1, route.legs.length);
}

/**
 * Probability the live venue will fill near the local model. Not a crystal
 * ball — a structural prior from hops, impact and depth, updated later by
 * calibrationHaircut from realized fills.
 */
export function executionProbability(opts: {
  hops: number;
  impactPct: number;
  tvlUsd: number;
  split?: boolean;
}): number {
  const hopPenalty = Math.max(0.35, 1 - 0.12 * Math.max(0, opts.hops - 1));
  const impactPenalty = clamp01(1 - opts.impactPct / 8);
  const depth = clamp01(Math.log10(Math.max(10, opts.tvlUsd)) / 5);
  const splitPenalty = opts.split ? 0.92 : 1;
  return clamp01(hopPenalty * impactPenalty * (0.55 + 0.45 * depth) * splitPenalty);
}

export function freshnessFactor(quoteAgeMs: number, maxQuoteAgeMs: number): number {
  return clamp01(1 - quoteAgeMs / Math.max(1, maxQuoteAgeMs));
}

/**
 * Inventory tilt: buying an underweight asset is slightly more valuable;
 * buying an overweight asset must clear a higher bar. Never turns a losing
 * trade into a winner (the caller still requires expectedNetProfitUsd > 0
 * for profit intent).
 */
export function inventoryFactor(opts: {
  snap: LeefSnapshot;
  balances: BalanceBook;
  tokenOut: string;
}): number {
  const view = portfolioState(opts.snap, opts.balances);
  if (!(view.totalUsd > 0) || view.assets.length === 0) return 1;
  const out = opts.tokenOut.toUpperCase();
  const asset = view.assets.find(
    (a) =>
      a.token.symbol.toUpperCase() === out ||
      `${a.token.symbol}@${a.token.contract}`.toUpperCase() === out,
  );
  const band = DEFAULT_GOVERNOR.bands.find((b) => {
    const id = b.tokenId.toUpperCase();
    return id.startsWith(`${out}@`) || id === out;
  });
  const target = band?.targetPct ?? 30;
  const current = asset?.sharePct ?? 0;
  const gap = (target - current) / 100; // + = underweight
  // 0.75 (very overweight) … 1 … 1.25 (very underweight)
  return Math.min(1.25, Math.max(0.75, 1 + gap));
}

/**
 * If we predicted +0.8% and realized +0.1%, haircut future predictions.
 * Uncalibrated strategies (few trades) are trusted at 1.0.
 */
export function calibrationHaircut(perf: CalibrationMemory | undefined): number {
  if (!perf || perf.trades < 3) return 1;
  const pred = perf.predEdgePctSum / perf.trades;
  const real = perf.realEdgePctSum / perf.trades;
  if (!(pred > 0)) return real >= 0 ? 1 : 0.7;
  return Math.min(1.15, Math.max(0.3, real / pred));
}

export function scoreExpectedValue(opts: {
  expectedNetProfitUsd: number;
  executionProbability: number;
  freshnessFactor: number;
  inventoryFactor: number;
  calibrationHaircut: number;
  strategyConfidence: number;
}): number {
  return (
    opts.expectedNetProfitUsd *
    opts.executionProbability *
    opts.freshnessFactor *
    opts.inventoryFactor *
    opts.calibrationHaircut *
    clamp01(opts.strategyConfidence)
  );
}

export function scoreOpportunityCard(opts: {
  expectedNetProfitUsd: number;
  executionProbability: number;
  freshnessFactor: number;
  inventoryFactor: number;
  hops: number;
  impactPct: number;
  liquidityUsd: number;
}): number {
  const profit = clamp01(opts.expectedNetProfitUsd / 0.5);
  const hops = clamp01(1 - 0.15 * Math.max(0, opts.hops - 1));
  const impact = clamp01(1 - opts.impactPct / 6);
  const liq = clamp01(Math.log10(Math.max(10, opts.liquidityUsd)) / 5);
  return Math.round(
    100 *
      profit *
      opts.executionProbability *
      hops *
      impact *
      liq *
      opts.freshnessFactor *
      Math.min(1.1, opts.inventoryFactor),
  );
}

export function buildScoredOpportunity(opts: {
  fingerprint: string;
  intent: OpportunityIntent;
  source: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  notionalUsd: number;
  expectedNetProfitUsd: number;
  expectedNetEdgePct: number;
  hops: number;
  liquidityUsd: number;
  impactPct: number;
  split?: boolean;
  quoteAgeMs: number;
  maxQuoteAgeMs: number;
  inventoryFactor: number;
  calibrationHaircut: number;
  strategyConfidence: number;
}): ScoredOpportunity {
  const exec = executionProbability({
    hops: opts.hops,
    impactPct: opts.impactPct,
    tvlUsd: opts.liquidityUsd,
    split: opts.split,
  });
  const fresh = freshnessFactor(opts.quoteAgeMs, opts.maxQuoteAgeMs);
  const expectedValueUsd = scoreExpectedValue({
    expectedNetProfitUsd: opts.expectedNetProfitUsd,
    executionProbability: exec,
    freshnessFactor: fresh,
    inventoryFactor: opts.inventoryFactor,
    calibrationHaircut: opts.calibrationHaircut,
    strategyConfidence: opts.strategyConfidence,
  });
  const explain = [
    `EV $${expectedValueUsd.toFixed(4)} = net $${opts.expectedNetProfitUsd.toFixed(4)} × exec ${(exec * 100).toFixed(0)}% × fresh ${(fresh * 100).toFixed(0)}% × inv ${opts.inventoryFactor.toFixed(2)} × cal ${opts.calibrationHaircut.toFixed(2)}`,
    `${opts.hops} hop${opts.hops === 1 ? "" : "s"} · impact ${opts.impactPct.toFixed(2)}% · TVL $${opts.liquidityUsd.toFixed(0)}`,
    `edge ${opts.expectedNetEdgePct.toFixed(2)}% on $${opts.notionalUsd.toFixed(2)}`,
  ];
  return {
    fingerprint: opts.fingerprint,
    intent: opts.intent,
    source: opts.source,
    tokenIn: opts.tokenIn,
    tokenOut: opts.tokenOut,
    amountIn: opts.amountIn,
    notionalUsd: opts.notionalUsd,
    expectedNetProfitUsd: opts.expectedNetProfitUsd,
    expectedNetEdgePct: opts.expectedNetEdgePct,
    hops: opts.hops,
    liquidityUsd: opts.liquidityUsd,
    impactPct: opts.impactPct,
    executionProbability: exec,
    freshnessFactor: fresh,
    inventoryFactor: opts.inventoryFactor,
    calibrationHaircut: opts.calibrationHaircut,
    strategyConfidence: opts.strategyConfidence,
    expectedValueUsd,
    score: scoreOpportunityCard({
      expectedNetProfitUsd: opts.expectedNetProfitUsd,
      executionProbability: exec,
      freshnessFactor: fresh,
      inventoryFactor: opts.inventoryFactor,
      hops: opts.hops,
      impactPct: opts.impactPct,
      liquidityUsd: opts.liquidityUsd,
    }),
    explain,
  };
}

export type OpportunityGate = {
  minNetProfitUsd: number;
  minNetEdgePct: number;
  minExecutionProbability: number;
  maxImpactPct: number;
  maxQuoteAgeMs: number;
  /** Volume: max expected loss as a fraction of notional (e.g. 0.015 = 1.5%). */
  maxVolumeCostPct: number;
};

export const DEFAULT_OPPORTUNITY_GATE: OpportunityGate = {
  minNetProfitUsd: 0.0001,
  minNetEdgePct: 0.1,
  minExecutionProbability: 0.5,
  maxImpactPct: 3,
  maxQuoteAgeMs: 45_000,
  maxVolumeCostPct: 1.5,
};

export function rejectOpportunity(
  o: ScoredOpportunity,
  gate: OpportunityGate,
): string | null {
  if (o.freshnessFactor <= 0) return "STALE_DATA";
  // Round-trip arb/echo already nets impact into expectedNetProfitUsd; the
  // directional impact cap is for inventory-changing buys/sells.
  if (o.tokenIn.toUpperCase() !== o.tokenOut.toUpperCase() && o.impactPct > gate.maxImpactPct) {
    return "IMPACT_TOO_HIGH";
  }
  if (o.executionProbability < gate.minExecutionProbability) return "LOW_EXECUTION_PROBABILITY";
  if (o.intent === "profit") {
    if (o.expectedNetProfitUsd < gate.minNetProfitUsd) return "INSUFFICIENT_EDGE";
    if (o.expectedNetEdgePct < gate.minNetEdgePct) return "INSUFFICIENT_EDGE";
    if (o.expectedValueUsd <= 0) return "NON_POSITIVE_EV";
  }
  if (o.intent === "volume") {
    const costPct =
      o.notionalUsd > 0 ? (Math.max(0, -o.expectedNetProfitUsd) / o.notionalUsd) * 100 : 100;
    if (costPct > gate.maxVolumeCostPct) return "VOLUME_TOO_EXPENSIVE";
    if (o.executionProbability < Math.max(gate.minExecutionProbability, 0.7)) {
      return "VOLUME_EXEC_TOO_LOW";
    }
  }
  return null;
}

/**
 * Rank by expected VALUE. Intent is a tie-break only (profit > rebalance >
 * volume) — a high-confidence $0.90 1-hop beats a theoretical $1.20 3-hop
 * once haircuts land. Doing nothing (empty / all rejected) is valid.
 */
export function selectBestOpportunity(
  candidates: ScoredOpportunity[],
  gate: OpportunityGate,
  now = Date.now(),
): { winner: ScoredOpportunity | null; rejected: { fingerprint: string; reason: string }[] } {
  const rejected: { fingerprint: string; reason: string }[] = [];
  const live: ScoredOpportunity[] = [];
  for (const c of candidates) {
    if (isDeadOpportunity(c.fingerprint, now)) {
      rejected.push({ fingerprint: c.fingerprint, reason: "COOLDOWN" });
      continue;
    }
    const why = rejectOpportunity(c, gate);
    if (why) {
      rejected.push({ fingerprint: c.fingerprint, reason: why });
      continue;
    }
    live.push(c);
  }
  live.sort((a, b) => {
    const ev = b.expectedValueUsd - a.expectedValueUsd;
    if (Math.abs(ev) > 1e-9) return ev;
    const intentRank = { profit: 3, rebalance: 2, volume: 1 };
    return intentRank[b.intent] - intentRank[a.intent];
  });
  return { winner: live[0] ?? null, rejected };
}

/* ------------------------------------------------------------------ */
/* Dead-opportunity cooldown — don't hammer the same failed clip.       */
/* ------------------------------------------------------------------ */

const deadUntil = new Map<string, number>();

export function markDeadOpportunity(fingerprint: string, cooldownMs: number, now = Date.now()): void {
  if (!fingerprint) return;
  deadUntil.set(fingerprint, now + Math.max(1_000, cooldownMs));
}

export function isDeadOpportunity(fingerprint: string, now = Date.now()): boolean {
  const until = deadUntil.get(fingerprint);
  if (until == null) return false;
  if (until <= now) {
    deadUntil.delete(fingerprint);
    return false;
  }
  return true;
}

export function clearDeadOpportunities(): void {
  deadUntil.clear();
}

export function opportunityFingerprint(parts: {
  kind: string;
  tokenIn: string;
  tokenOut: string;
  routeId?: string;
}): string {
  return `${parts.kind}:${parts.tokenIn.toUpperCase()}>${parts.tokenOut.toUpperCase()}:${parts.routeId ?? ""}`;
}
