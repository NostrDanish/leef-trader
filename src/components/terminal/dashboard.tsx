import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { quoteConstantProduct } from "@/lib/leef/amm";
import { feeApyPct, tradeSpark } from "@/lib/leef/analytics";
import { fmtNum, fmtPct, fmtUsd } from "@/lib/leef/format";
import type { LeefPool, LeefSnapshot } from "@/lib/leef/types";
import { cn } from "@/lib/utils";
import { useTerminal } from "@/store/terminal";

export function Dashboard({ snap }: { snap: LeefSnapshot }) {
  const selectedId = useTerminal((s) => s.selectedPoolId);
  const setTab = useTerminal((s) => s.setTab);
  const pool =
    snap.pools.find((p) => p.id === selectedId) ??
    snap.pools.find((p) => p.pair.symbol === "WAX") ??
    snap.pools[0];

  if (!pool) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        No LEEF pool loaded.
      </Card>
    );
  }

  const waxUsd = snap.waxUsd;
  const pairUsd = pool.usdPerLeef ? pool.leef.quantity * pool.usdPerLeef : 0;
  const apy = feeApyPct(pool);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-medium tracking-tight">
            LEEF / {pool.pair.symbol} · #{pool.id}
          </h2>
          <p className="text-xs text-muted-foreground">
            {pool.leef.contract} · {pool.pair.contract} · {pool.feePct}% fee
            {pool.firstSeenAt
              ? ` · live since ${new Date(pool.firstSeenAt).toLocaleDateString()}`
              : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant={pool.change24 >= 0 ? "buy" : "sell"}>
            {pool.change24 >= 0 ? "+" : ""}
            {pool.change24.toFixed(2)}% 24h
          </Badge>
          <Badge variant="accent">{fmtNum(apy, { digits: 1 })}% fee APY</Badge>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          kicker="LEEF reserve"
          value={`${fmtNum(pool.leef.quantity, { compact: true })} LEEF`}
          sub={fmtUsd(pairUsd)}
          tone="leef"
          foot={pool.leef.contract}
        />
        <Metric
          kicker={`${pool.pair.symbol} reserve`}
          value={`${fmtNum(pool.pair.quantity, { compact: true })} ${pool.pair.symbol}`}
          sub={
            pool.pair.symbol === "WAX"
              ? fmtUsd(pool.pair.quantity * waxUsd)
              : pool.pair.contract
          }
          tone="wax"
          foot={pool.pair.contract}
        />
        <Metric
          kicker="Spot · 1M LEEF"
          value={`${fmtNum((pool.waxPerLeef ?? pool.pairPerLeef) * 1e6, { digits: 3 })} ${pool.pair.symbol === "WAX" ? "WAX" : pool.pair.symbol}`}
          sub={`1 ${pool.pair.symbol} = ${fmtNum(pool.leefPerPair, { compact: true })} LEEF`}
          foot={`Week ${pool.changeWeek >= 0 ? "+" : ""}${pool.changeWeek.toFixed(2)}%`}
        />
        <Metric
          kicker="TVL"
          value={fmtUsd(pool.tvlUsd)}
          sub={`24h ${fmtUsd(pool.volume24Usd)} · 7d ${fmtUsd(pool.volumeWeekUsd)}`}
          foot={`k = ${(pool.leef.quantity * pool.pair.quantity).toExponential(2)}`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <VolumeAndPrint snap={snap} pool={pool} />
        </Card>
        <Card className="flex flex-col p-5">
          <h3 className="text-sm font-medium">Reserve mix</h3>
          <p className="mb-4 text-xs text-muted-foreground">
            Notional split using the LEEF USD print from the WAX book.
          </p>
          <MixBar pool={pool} leefUsd={snap.leefUsd} waxUsd={waxUsd} />
          <div className="mt-auto pt-4">
            <Button className="w-full" onClick={() => setTab("quotes")}>
              Quote this book vs the rest
            </Button>
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <DepthCurve pool={pool} />
      </Card>
    </div>
  );
}

function Metric({
  kicker,
  value,
  sub,
  foot,
  tone,
}: {
  kicker: string;
  value: string;
  sub: string;
  foot: string;
  tone?: "leef" | "wax";
}) {
  return (
    <Card
      className={cn(
        "p-4 border-l-2",
        tone === "leef" ? "border-l-leef" : tone === "wax" ? "border-l-wax" : "border-l-accent",
      )}
    >
      <div className="text-xs uppercase tracking-wider text-subtle">{kicker}</div>
      <div className="mt-1 font-mono text-lg tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
      <div className="mt-3 border-t border-border pt-2 font-mono text-xs text-subtle">
        {foot}
      </div>
    </Card>
  );
}

function MixBar({
  pool,
  leefUsd,
  waxUsd,
}: {
  pool: LeefPool;
  leefUsd: number;
  waxUsd: number;
}) {
  const leefSide = pool.leef.quantity * (pool.usdPerLeef ?? leefUsd);
  const pairSide =
    pool.pair.symbol === "WAX"
      ? pool.pair.quantity * waxUsd
      : Math.max(pool.tvlUsd - leefSide, 0);
  const total = leefSide + pairSide || 1;
  const lp = (leefSide / total) * 100;
  const pp = 100 - lp;
  const k = pool.leef.quantity * pool.pair.quantity;
  const ref = quoteConstantProduct(10, pool.pair.quantity, pool.leef.quantity, pool.fee);

  return (
    <div className="space-y-4">
      <div className="flex justify-between text-xs">
        <span className="text-leef">LEEF {lp.toFixed(1)}%</span>
        <span className="text-wax">
          {pool.pair.symbol} {pp.toFixed(1)}%
        </span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-bg">
        <div className="bg-leef" style={{ width: `${lp}%` }} />
        <div className="bg-wax" style={{ width: `${pp}%` }} />
      </div>
      <div className="rounded-lg border border-border bg-bg p-3 font-mono text-xs">
        <div className="flex justify-between text-muted-foreground">
          <span>Constant product k</span>
          <span className="text-accent">x · y = k</span>
        </div>
        <div className="mt-1 truncate tabular-nums">{k.toExponential(4)}</div>
        <p className="mt-2 font-sans text-subtle">
          10 {pool.pair.symbol} still buys {fmtNum(ref.amountOut, { compact: true })} LEEF
          here · impact {fmtPct(ref.priceImpact, 2, false)}.
        </p>
      </div>
    </div>
  );
}

function VolumeAndPrint({ snap, pool }: { snap: LeefSnapshot; pool: LeefPool }) {
  const spark = useMemo(
    () => tradeSpark(snap.trades, pool.id),
    [snap.trades, pool.id],
  );
  const windows = [
    { label: "24h", usd: pool.volume24Usd, leef: pool.volumeLeef24 },
    { label: "7d", usd: pool.volumeWeekUsd, leef: 0 },
    { label: "30d", usd: pool.volumeUsdMonth, leef: 0 },
    { label: "90d", usd: pool.volumeUsd90, leef: 0 },
  ];

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div>
        <h3 className="text-sm font-medium">Volume windows</h3>
        <p className="mb-3 text-xs text-muted-foreground">USD notional reported by Alcor.</p>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={windows}>
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 6" />
              <XAxis
                dataKey="label"
                tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={48}
                tickFormatter={(v: number) => `$${Math.round(v)}`}
              />
              <RTooltip
                contentStyle={tooltipStyle}
                formatter={(v) => [fmtUsd(Number(v), 2), "Volume"]}
              />
              <Bar dataKey="usd" fill="var(--color-accent)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div>
        <h3 className="text-sm font-medium">Recent prints</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          {spark.length >= 2
            ? `Fill prices from the last ${spark.length} swaps on this book.`
            : "No recent swaps in this snapshot — showing spot only."}
        </p>
        {spark.length >= 2 ? (
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={spark}>
                <defs>
                  <linearGradient id="pxFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 6" />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  domain={["auto", "auto"]}
                  tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={64}
                  tickFormatter={(v: number) => v.toExponential(1)}
                />
                <RTooltip
                  contentStyle={tooltipStyle}
                  formatter={(v) => [fmtNum(Number(v), { digits: 8 }), "Print"]}
                />
                <Area
                  type="monotone"
                  dataKey="px"
                  stroke="var(--color-accent)"
                  fill="url(#pxFill)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-48 items-center rounded-lg border border-border bg-bg px-4 text-sm text-muted-foreground">
            Spot {fmtNum(pool.pairPerLeef, { digits: 8 })} {pool.pair.symbol} / LEEF
          </div>
        )}
      </div>
    </div>
  );
}

function DepthCurve({ pool }: { pool: LeefPool }) {
  const data = useMemo(() => {
    const sizes = [1, 2, 5, 10, 25, 50, 100, 250, 500];
    return sizes
      .filter((sz) => sz < pool.pair.quantity * 0.4)
      .map((sz) => {
        const q = quoteConstantProduct(
          sz,
          pool.pair.quantity,
          pool.leef.quantity,
          pool.fee,
        );
        return {
          size: sz,
          impact: q.priceImpact * 100,
          out: q.amountOut,
        };
      });
  }, [pool]);

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-sm font-medium">Buy-side impact</h3>
        <p className="text-xs text-muted-foreground">
          Price impact of buying LEEF with {pool.pair.symbol} against live reserves.
        </p>
      </div>
      {data.length < 2 ? (
        <p className="text-sm text-muted-foreground">Book is too thin to chart size.</p>
      ) : (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <defs>
                <linearGradient id="impFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-sell)" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="var(--color-sell)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 6" />
              <XAxis
                dataKey="size"
                tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => String(v)}
              />
              <YAxis
                tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={48}
                tickFormatter={(v: number) => `${v.toFixed(1)}%`}
              />
              <RTooltip
                contentStyle={tooltipStyle}
                formatter={(v, name) =>
                  name === "impact"
                    ? [`${Number(v).toFixed(2)}%`, "Impact"]
                    : [fmtNum(Number(v), { compact: true }), "LEEF out"]
                }
                labelFormatter={(l) => `${l} ${pool.pair.symbol}`}
              />
              <Area
                type="monotone"
                dataKey="impact"
                stroke="var(--color-sell)"
                fill="url(#impFill)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

const tooltipStyle = {
  background: "var(--color-surface-2)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 12,
};
