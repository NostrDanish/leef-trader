import { useMemo, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartFrame } from "./chart-frame";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  hhiLabel,
  marketStats,
  poolMix,
  waxBookRows,
} from "@/lib/leef/analytics";
import { fmtLeefLot, fmtNum, fmtPct, fmtUsd } from "@/lib/leef/format";
import { headline } from "@/lib/leef/rank";
import type { LeefSnapshot, RankedPool } from "@/lib/leef/types";
import { cn } from "@/lib/utils";
import { useTerminal } from "@/store/terminal";
import { PairMarks } from "./token-mark";

export function Overview({
  snap,
  ranked,
}: {
  snap: LeefSnapshot;
  ranked: RankedPool[];
}) {
  const selectPool = useTerminal((s) => s.selectPool);
  const setTab = useTerminal((s) => s.setTab);
  const stats = useMemo(() => marketStats(snap), [snap]);
  const mix = useMemo(() => poolMix(snap.pools, 7), [snap.pools]);
  const waxBooks = useMemo(() => waxBookRows(ranked), [ranked]);
  const head = headline(ranked);
  const chartRows = useMemo(() => {
    const rows = mix.rows.map((r) => ({
      name: `${r.pair} #${r.id}`,
      tvl: r.tvlUsd,
      vol: r.volume24Usd,
    }));
    if (mix.other) {
      rows.push({ name: mix.other.pair, tvl: mix.other.tvlUsd, vol: mix.other.volume24Usd });
    }
    return rows;
  }, [mix]);

  const movers = [...ranked]
    .filter((p) => p.tvlUsd >= 5)
    .sort((a, b) => Math.abs(b.change24) - Math.abs(a.change24))
    .slice(0, 6);

  return (
    <div className="flex flex-col gap-5">
      {head.arb && (
        <Card className="border-warn/30 bg-warn/5 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-warn">
                Cross-pool spread
              </div>
              <p className="mt-1 max-w-2xl text-sm">
                LEEF prints {fmtPct(head.arb.spreadPct, 1, false)} cheaper on pool #
                {head.arb.cheap.id} ({head.arb.cheap.pair.symbol}) than on pool #
                {head.arb.rich.id}. Size for impact before treating it as arb.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => selectPool(head.arb!.cheap.id)}
            >
              Open cheap book
            </Button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi
          label="1 LEEF"
          value={fmtUsd(snap.leefUsd)}
          sub={<Change n={stats.change24} suffix="24h" />}
        />
        <Kpi
          label="10M LEEF"
          value={`${fmtLeefLot(snap.waxPerLeef, 4)} WAX`}
          sub={`${fmtUsd(snap.leefUsd * 10_000_000)} · ${fmtUsd(snap.waxUsd, 4)} / WAX`}
          tone="wax"
        />
        <Kpi
          label="LEEF TVL"
          value={fmtUsd(stats.tvlUsd, 0)}
          sub={`${stats.listedCount} of ${stats.poolCount} books`}
        />
        <Kpi
          label="24h volume"
          value={fmtUsd(stats.volume24Usd, 0)}
          sub={`7d ${fmtUsd(stats.volumeWeekUsd, 0)}`}
        />
        <Kpi
          label="LEEF locked"
          value={fmtNum(stats.leefLocked, { compact: true })}
          sub={fmtUsd(stats.leefLockedUsd, 0)}
          tone="leef"
        />
        <Kpi
          label="Blended fee APY"
          value={`${fmtNum(stats.feeApyPct, { digits: 1 })}%`}
          sub={`${fmtUsd(stats.fee24Usd, 2)} fees / 24h`}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="p-4 sm:p-5 lg:col-span-2">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">Liquidity mix</h2>
              <p className="text-xs text-muted-foreground">
                TVL and 24h volume across LEEF books on Alcor.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setTab("pools")}>
              All pools
            </Button>
          </div>
          <ChartFrame className="h-72">
              <BarChart data={chartRows} layout="vertical" margin={{ left: 8, right: 12 }}>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 6" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => `$${Math.round(v)}`}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={96}
                  tick={{ fill: "var(--color-muted)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <RTooltip
                  cursor={{ fill: "var(--color-surface-2)" }}
                  contentStyle={tooltipStyle}
                  formatter={(v, name) => [
                    fmtUsd(Number(v), 2),
                    name === "tvl" ? "TVL" : "24h vol",
                  ]}
                />
                <Bar dataKey="tvl" fill="var(--color-accent)" radius={[0, 4, 4, 0]} barSize={10} />
                <Bar dataKey="vol" fill="var(--color-wax)" radius={[0, 4, 4, 0]} barSize={10} />
              </BarChart>
          </ChartFrame>
        </Card>

        <Card className="flex flex-col p-5">
          <h2 className="text-sm font-medium">Market structure</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            How concentrated LEEF liquidity is, and what the books pay.
          </p>
          <dl className="space-y-3 text-xs">
            <StatRow label="HHI" value={`${stats.hhi.toFixed(3)} · ${hhiLabel(stats.hhi)}`} />
            <StatRow
              label="Top book share"
              value={fmtPct(stats.topShare, 1, false)}
            />
            <StatRow label="Turnover (vol / TVL)" value={`${(stats.turnover * 100).toFixed(1)}%`} />
            <StatRow
              label="WAX locked"
              value={`${fmtNum(stats.waxLocked, { digits: 0 })} · ${fmtUsd(stats.waxLockedUsd, 0)}`}
            />
            <StatRow
              label="7d / 30d volume"
              value={`${fmtUsd(stats.volumeWeekUsd, 0)} · ${fmtUsd(stats.volumeMonthUsd, 0)}`}
            />
            <StatRow
              label="Week change (lead WAX)"
              value={
                stats.changeWeek == null
                  ? "—"
                  : `${stats.changeWeek >= 0 ? "+" : ""}${stats.changeWeek.toFixed(2)}%`
              }
            />
          </dl>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-bg">
            <div
              className="h-full bg-accent"
              style={{ width: `${Math.min(100, stats.topShare * 100)}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-subtle">
            Lead book holds {fmtPct(stats.topShare, 1, false)} of LEEF TVL.
          </p>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-4 sm:p-5">
          <div className="mb-4">
            <h2 className="text-sm font-medium">WAX books · 10M LEEF</h2>
            <p className="text-xs text-muted-foreground">
              Spot WAX paid per 10 million LEEF. Cheaper is a better buy.
            </p>
          </div>
          {waxBooks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No WAX books in this snapshot.</p>
          ) : (
            <div className="space-y-3">
              {waxBooks.map((p) => {
                const max = Math.max(
                  ...waxBooks.map((x) => (x.waxPerMillionLeef ?? 0) * 10),
                  1,
                );
                const v = (p.waxPerMillionLeef ?? 0) * 10;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => selectPool(p.id)}
                    className="block w-full text-left"
                  >
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-subtle">#{p.id}</span>
                        <span>{p.feePct}% fee</span>
                        {p.badges.includes("best-buy") && (
                          <Badge variant="buy">Best buy</Badge>
                        )}
                        {p.badges.includes("best-sell") && (
                          <Badge variant="accent">Best sell</Badge>
                        )}
                      </span>
                      <span className="font-mono tabular-nums">
                        {fmtNum(v, { digits: 4 })} WAX
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-bg">
                      <div
                        className="h-full bg-wax"
                        style={{ width: `${(v / max) * 100}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <Card className="p-4 sm:p-5">
          <div className="mb-4">
            <h2 className="text-sm font-medium">24h movers</h2>
            <p className="text-xs text-muted-foreground">Largest Alcor 24h change among listed books.</p>
          </div>
          <div className="space-y-1">
            {movers.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => selectPool(p.id)}
                className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left hover:bg-surface-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <PairMarks pair={p.pair.symbol} />
                  <span className="truncate text-sm">
                    LEEF / {p.pair.symbol}
                    <span className="ml-2 font-mono text-xs text-subtle">#{p.id}</span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-3 text-xs">
                  <span className="hidden font-mono tabular-nums text-muted-foreground sm:inline">
                    {fmtUsd(p.volume24Usd, 0)}
                  </span>
                  <Change n={p.change24} />
                </span>
              </button>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: ReactNode;
  tone?: "leef" | "wax";
}) {
  return (
    <Card
      className={cn(
        "p-4 border-l-2",
        tone === "leef" ? "border-l-leef" : tone === "wax" ? "border-l-wax" : "border-l-accent",
      )}
    >
      <div className="text-xs uppercase tracking-wider text-subtle">{label}</div>
      <div className="mt-1 truncate font-mono text-lg tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
    </Card>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono tabular-nums text-fg">{value}</dd>
    </div>
  );
}

function Change({ n, suffix }: { n: number | null | undefined; suffix?: string }) {
  if (n == null || !Number.isFinite(n)) {
    return <span className="text-subtle">—</span>;
  }
  const pos = n >= 0;
  return (
    <span className={cn("font-mono tabular-nums", pos ? "text-buy" : "text-sell")}>
      {pos ? "+" : ""}
      {n.toFixed(2)}%{suffix ? ` ${suffix}` : ""}
    </span>
  );
}

const tooltipStyle = {
  background: "var(--color-surface-2)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 12,
};
