/**
 * Strategy PnL from the evidence journal (contract: CORE implements, UI
 * consumes). REAL fills only: journal execution entries carry the realized
 * pnlUsd computed from actual on-chain/paper reconciliation — no estimates,
 * no marks. Empty journal → empty series (honest empty state).
 */

export interface StrategyPnlPoint {
  /** ms epoch of the fill. */
  t: number;
  strategy: string;
  /** Realized USD PnL of this fill. */
  realizedUsd: number;
  /** Running sum for this strategy, oldest → newest. */
  cumulativeUsd: number;
}

type JournalLike = {
  ts?: unknown;
  kind?: unknown;
  strategy?: unknown;
  pnlUsd?: unknown;
  amountIn?: unknown;
  expectedOut?: unknown;
  selfImpactPct?: unknown;
};

/**
 * Execution entries with a realized pnlUsd → per-strategy cumulative series,
 * sorted by time. Self-impact follow-up observations (no amounts) are
 * skipped, mirroring the journal's own aggregation rules.
 */
export function computeStrategyPnl(journalEntries: unknown[]): StrategyPnlPoint[] {
  const fills: { t: number; strategy: string; pnl: number }[] = [];
  for (const raw of journalEntries) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as JournalLike;
    if (e.kind !== "execution") continue;
    if (e.amountIn == null && e.expectedOut == null && e.selfImpactPct != null) continue;
    const pnl = typeof e.pnlUsd === "number" && Number.isFinite(e.pnlUsd) ? e.pnlUsd : null;
    const t = typeof e.ts === "number" && Number.isFinite(e.ts) ? e.ts : null;
    if (pnl == null || t == null) continue;
    fills.push({
      t,
      strategy: typeof e.strategy === "string" && e.strategy ? e.strategy : "unknown",
      pnl,
    });
  }
  fills.sort((a, b) => a.t - b.t);
  const cumulative = new Map<string, number>();
  return fills.map((f) => {
    const next = (cumulative.get(f.strategy) ?? 0) + f.pnl;
    cumulative.set(f.strategy, next);
    return { t: f.t, strategy: f.strategy, realizedUsd: f.pnl, cumulativeUsd: next };
  });
}
