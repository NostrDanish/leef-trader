/**
 * Market-aware rebalance sizing — the rebalancer's job is NOT "make the
 * portfolio hit the target as fast as possible"; it is "move toward the
 * target with the least economic damage per dollar of progress".
 *
 *   TARGET GAP ≠ ORDER SIZE
 *
 * The rule, deliberately simple and deterministic:
 *
 *   candidate sizes (adaptive ladder over [min, max])
 *     → cheap local quote each (impact + total cost)
 *     → viable = impact ≤ the urgency-scaled marginal budget
 *     → none viable        → WAIT      (never slam a thin pool)
 *     → largest viable < gap → EXECUTE_PARTIAL (partial convergence)
 *     → gap itself viable    → EXECUTE_FULL
 *
 * Why "largest under the budget" is the marginal-impact rule: on a CP book,
 * impact is monotone increasing in size, so the budget crossing point IS the
 * knee — past it, every additional dollar costs disproportionately more.
 * Deadband/hysteresis lives upstream in planRebalance (driftPct); the router
 * may still split books when that pays; the exact venue gate re-verifies the
 * chosen size before anything signs.
 */

export type RebalanceAction = "NO_ACTION" | "WAIT" | "EXECUTE_PARTIAL" | "EXECUTE_FULL";

export type SizeQuote = {
  /** Price impact of the route at this size, percent. */
  impactPct: number;
  /** Total execution cost (venue fee + impact + platform fee), percent. */
  costPct: number;
};

export type RebalanceSizeDecision = {
  action: RebalanceAction;
  /** USD to execute now (0 for NO_ACTION/WAIT). */
  sizeUsd: number;
  /** Gap remaining after this execution. */
  remainingUsd: number;
  reason: string;
  tried: { sizeUsd: number; impactPct: number; costPct: number }[];
};

/** Absolute impact anchors (USD) probed alongside the fractional ladder. */
const ABS_ANCHORS = [1, 2, 5, 10, 20, 50, 100];
const FRAC_LADDER = [0.1, 0.25, 0.5, 0.75, 1];

export function candidateSizesUsd(minUsd: number, maxUsd: number): number[] {
  const set = new Set<number>();
  for (const a of ABS_ANCHORS) {
    if (a >= minUsd && a <= maxUsd) set.add(a);
  }
  for (const f of FRAC_LADDER) {
    const v = minUsd + (maxUsd - minUsd) * f;
    if (v >= minUsd && v <= maxUsd) set.add(Math.round(v * 100) / 100);
  }
  set.add(maxUsd);
  if (minUsd > 0) set.add(minUsd);
  return [...set].sort((a, b) => a - b);
}

export function chooseRebalanceSize(opts: {
  gapUsd: number;
  minUsd: number;
  maxUsd: number;
  /** Urgency-scaled marginal impact budget, percent (caller caps at the hard risk limit). */
  budgetPct: number;
  /** Cheap local estimate per size; null = unquotable at that size. */
  quoteAt: (sizeUsd: number) => SizeQuote | null;
}): RebalanceSizeDecision {
  const { gapUsd, minUsd, maxUsd, budgetPct, quoteAt } = opts;
  const empty = { sizeUsd: 0, remainingUsd: Math.max(0, gapUsd), tried: [] };
  if (!(gapUsd > 0)) return { action: "NO_ACTION", reason: "no gap", ...empty };
  if (!(maxUsd > 0) || maxUsd + 1e-12 < minUsd) {
    return { action: "NO_ACTION", reason: "no deployable capacity above the minimum", ...empty };
  }
  const cap = Math.min(maxUsd, gapUsd);
  const sizes = candidateSizesUsd(minUsd, cap);

  const tried: RebalanceSizeDecision["tried"] = [];
  let best: { sizeUsd: number; impactPct: number; costPct: number } | null = null;
  let smallestQuoted: { sizeUsd: number; impactPct: number } | null = null;
  for (const sizeUsd of sizes) {
    const q = quoteAt(sizeUsd);
    if (!q) continue;
    tried.push({ sizeUsd, impactPct: q.impactPct, costPct: q.costPct });
    if (!smallestQuoted) smallestQuoted = { sizeUsd, impactPct: q.impactPct };
    // Viable = inside the marginal impact budget. Impact is monotone in size
    // on a CP book, so the LARGEST viable size sits at the knee.
    if (q.impactPct <= budgetPct + 1e-12) best = { sizeUsd, ...q };
  }

  if (!best) {
    const reason = smallestQuoted
      ? `WAIT — even $${smallestQuoted.sizeUsd.toFixed(2)} reads ${smallestQuoted.impactPct.toFixed(2)}% impact, over the ${budgetPct.toFixed(2)}% budget`
      : "WAIT — no quotable route at any candidate size";
    return { action: "WAIT", reason, sizeUsd: 0, remainingUsd: gapUsd, tried };
  }

  if (best.sizeUsd + 1e-9 >= gapUsd) {
    return {
      action: "EXECUTE_FULL",
      sizeUsd: best.sizeUsd,
      remainingUsd: 0,
      reason: `full $${gapUsd.toFixed(2)} gap executes at ${best.impactPct.toFixed(2)}% impact (budget ${budgetPct.toFixed(2)}%)`,
      tried,
    };
  }
  return {
    action: "EXECUTE_PARTIAL",
    sizeUsd: best.sizeUsd,
    remainingUsd: gapUsd - best.sizeUsd,
    reason: `partial: $${best.sizeUsd.toFixed(2)} of $${gapUsd.toFixed(2)} — larger sizes break the ${budgetPct.toFixed(2)}% impact budget (${best.impactPct.toFixed(2)}% at this size)`,
    tried,
  };
}

/**
 * Urgency → marginal impact budget. A bigger relative gap earns a wider
 * budget, never beyond the hard risk cap. Rebalancing is maintenance — the
 * budget exists to refuse market damage, not to force convergence.
 */
export function rebalanceImpactBudgetPct(
  gapFrac: number,
  hardCapPct: number,
): { budgetPct: number; urgency: "low" | "normal" | "high" | "emergency" } {
  const scaled =
    gapFrac < 0.05 ? 0.5 : gapFrac < 0.15 ? 1.0 : gapFrac < 0.3 ? 1.5 : 2.0;
  const urgency = gapFrac < 0.05 ? "low" : gapFrac < 0.15 ? "normal" : gapFrac < 0.3 ? "high" : "emergency";
  return { budgetPct: Math.min(scaled, hardCapPct), urgency };
}
