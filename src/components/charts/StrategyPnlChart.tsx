import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/card";
import { ChartFrame } from "@/components/terminal/chart-frame";
import { journalAll } from "@/lib/leef/journal";
import { computeStrategyPnl, type StrategyPnlPoint } from "@/lib/market/pnl";
import { fmtUsd } from "@/lib/leef/format";
import { ChartEmpty, ChartError, ChartSkeleton } from "./chart-state";

/** Warm, low-saturation series colors (src/index.css palette). */
const SERIES_COLORS = [
  "var(--color-leef)",
  "var(--color-wax)",
  "var(--color-accent)",
  "var(--color-warn)",
  "var(--color-buy)",
  "var(--color-sell)",
];
const MAX_SERIES = 6;

/**
 * Real per-strategy PnL from the evidence journal (contract: pnl.ts). No
 * estimates — when the journal has no attributable fills, the card says so.
 */
export function StrategyPnlChart() {
  const q = useQuery({
    queryKey: ["strategy-pnl"],
    queryFn: async () => computeStrategyPnl(await journalAll()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3">
        <h3 className="text-sm font-medium">Strategy PnL</h3>
        <p className="text-xs text-muted-foreground">
          Cumulative realized USD per strategy, from the evidence journal.
        </p>
      </div>
      {q.isPending ? (
        <ChartSkeleton className="h-36" />
      ) : q.isError ? (
        <ChartError
          className="h-36"
          message={q.error instanceof Error ? q.error.message : "Journal read failed."}
          onRetry={() => void q.refetch()}
        />
      ) : q.data.length === 0 ? (
        <ChartEmpty className="h-36">
          No journaled fills yet — strategy PnL appears once the engines log real trades.
        </ChartEmpty>
      ) : (
        <PnlCanvas points={q.data} />
      )}
    </Card>
  );
}

function PnlCanvas({ points }: { points: StrategyPnlPoint[] }) {
  const { rows, strategies } = useMemo(() => {
    // Pivot: one row per timestamp, one key per strategy (latest cumulative).
    const totals = new Map<string, number>();
    for (const p of points) {
      totals.set(p.strategy, Math.max(totals.get(p.strategy) ?? 0, p.cumulativeUsd));
    }
    const strategies = [...totals.entries()]
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, MAX_SERIES)
      .map(([s]) => s);
    const keep = new Set(strategies);
    const byTime = new Map<number, Record<string, number>>();
    for (const p of points) {
      if (!keep.has(p.strategy)) continue;
      const row = byTime.get(p.t) ?? {};
      row[p.strategy] = p.cumulativeUsd;
      byTime.set(p.t, row);
    }
    const rows = [...byTime.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, r]) => ({ t, ...r }));
    return { rows, strategies };
  }, [points]);

  return (
    <ChartFrame className="h-36">
      <LineChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 6" />
        <XAxis
          dataKey="t"
          tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) =>
            new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          }
        />
        <YAxis
          tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={56}
          tickFormatter={(v: number) => fmtUsd(v, 2)}
        />
        <RTooltip
          contentStyle={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            fontSize: 12,
          }}
          formatter={(v, name) => [fmtUsd(Number(v), 2), String(name)]}
          labelFormatter={(l) => new Date(Number(l)).toLocaleString()}
        />
        {strategies.map((s, i) => (
          <Line
            key={s}
            type="stepAfter"
            dataKey={s}
            stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
            strokeWidth={1.5}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartFrame>
  );
}
