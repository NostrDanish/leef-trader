/**
 * Growth-target settings the shell persists. The planner in growth-engine
 * re-exports these; importing them must not pull the route graph.
 */
export type GrowthMode = "max" | "balanced" | "compound";

export type GrowthTarget = {
  symbol: string;
  /** 0–100 share of the treasure mix. */
  weight: number;
};

export const DEFAULT_GROWTH_TARGETS: GrowthTarget[] = [{ symbol: "LEEF", weight: 100 }];

export function normalizeTargets(raw: GrowthTarget[]): GrowthTarget[] {
  const seen = new Set<string>();
  const cleaned: GrowthTarget[] = [];
  for (const t of raw) {
    const symbol = t.symbol.toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    cleaned.push({ symbol, weight: Math.max(0, t.weight) });
    if (cleaned.length >= 5) break;
  }
  const sum = cleaned.reduce((s, t) => s + t.weight, 0);
  if (cleaned.length === 0) return [...DEFAULT_GROWTH_TARGETS];
  if (!(sum > 0)) {
    const w = 100 / cleaned.length;
    return cleaned.map((t) => ({ ...t, weight: w }));
  }
  return cleaned.map((t) => ({ ...t, weight: (t.weight / sum) * 100 }));
}
