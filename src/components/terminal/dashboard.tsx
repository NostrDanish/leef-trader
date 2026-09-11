import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Droplets, Minus, Plus } from "lucide-react";
import {
  Area,
  AreaChart,
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
import { Input } from "@/components/ui/input";
import { quoteConstantProduct } from "@/lib/leef/amm";
import { fetchPositions, type AmmPosition } from "@/lib/leef/positions";
import { signAndPushAddLiquidity, signAndPushRemoveLiquidity } from "@/lib/wallet/sign";
import { hasSecret } from "@/lib/wallet/secret";
import { hasWalletSession } from "@/lib/wallet/session";
import { useWallet } from "@/store/wallet";
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
        <Card className="min-w-0 p-4 sm:p-5 lg:col-span-2">
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

      <Card className="p-4 sm:p-5">
        <DepthCurve pool={pool} />
      </Card>

      <LpCard pool={pool} snap={snap} />
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
        <ChartFrame className="h-48">
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
        </ChartFrame>
      </div>
      <div>
        <h3 className="text-sm font-medium">Recent prints</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          {spark.length >= 2
            ? `Fill prices from the last ${spark.length} swaps on this book.`
            : "No recent swaps in this snapshot — showing spot only."}
        </p>
        {spark.length >= 2 ? (
          <ChartFrame className="h-48">
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
          </ChartFrame>
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
        <ChartFrame className="h-56">
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
        </ChartFrame>
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

/* ------------------------------------------------------------------ */
/* Liquidity positions (add / remove on swap.alcor)                     */
/* ------------------------------------------------------------------ */

function LpCard({ pool, snap }: { pool: LeefPool; snap: LeefSnapshot }) {
  const mode = useWallet((s) => s.mode);
  const account = useWallet((s) => s.account);
  const permission = useWallet((s) => s.permission);
  const setImportOpen = useWallet((s) => s.setImportOpen);
  const paperBalances = useWallet((s) => s.paperBalances);
  const liveBalances = useWallet((s) => s.liveBalances);
  const balances = mode === "live" ? liveBalances : paperBalances;
  const live = mode === "live" && (hasSecret() || hasWalletSession());

  const positionsQ = useQuery({
    queryKey: ["amm-positions", account],
    queryFn: () => fetchPositions(account),
    enabled: live && Boolean(account),
    refetchInterval: 45_000,
    staleTime: 20_000,
  });
  const positions = (positionsQ.data ?? []).filter((pos) => pos.poolId === pool.id);

  const [amountLeef, setAmountLeef] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const leefMeta = { contract: "leefmaincorp", symbol: "LEEF", decimals: pool.leef.decimals };
  const pairMeta = {
    contract: pool.pair.contract,
    symbol: pool.pair.symbol,
    decimals: pool.pair.decimals,
  };
  const tokenA = pool.leefIsA ? leefMeta : pairMeta;
  const tokenB = pool.leefIsA ? pairMeta : leefMeta;

  const pairPerLeef = pool.leef.quantity > 0 ? pool.pair.quantity / pool.leef.quantity : 0;
  const leefAmount = Number(amountLeef) || 0;
  const pairAmount = leefAmount * pairPerLeef;
  const enoughLeef = (balances.LEEF ?? 0) >= leefAmount;
  const enoughPair = (balances[pool.pair.symbol] ?? 0) >= pairAmount;

  const spacing = pool.tickSpacing || 60;
  const tickLower = Math.ceil(-887200 / spacing) * spacing;
  const tickUpper = Math.floor(887200 / spacing) * spacing;

  function flash(m: string, isErr = false) {
    if (isErr) setErr(m);
    else setNote(m);
    window.setTimeout(() => {
      setNote(null);
      setErr(null);
    }, 12_000);
  }

  async function onAdd() {
    setBusy(true);
    try {
      const aForA = pool.leefIsA ? leefAmount : pairAmount;
      const bForB = pool.leefIsA ? pairAmount : leefAmount;
      const { txid } = await signAndPushAddLiquidity({
        account,
        permission,
        poolId: pool.id,
        tokenA,
        tokenB,
        amountA: aForA,
        amountB: bForB,
        tickLower,
        tickUpper,
        slippagePct: 1,
      });
      flash(`Liquidity added · tx ${txid.slice(0, 10)}…`);
      setAmountLeef("");
      window.setTimeout(() => void positionsQ.refetch(), 5000);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Add liquidity failed", true);
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(pos: AmmPosition, pct: number) {
    setBusy(true);
    try {
      const liqOut = (pos.liquidity * BigInt(pct)) / 100n;
      const { txid } = await signAndPushRemoveLiquidity({
        account,
        permission,
        poolId: pool.id,
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        liquidity: liqOut,
        collectAll: pct === 100,
        tokenA: { symbol: tokenA.symbol, decimals: tokenA.decimals },
        tokenB: { symbol: tokenB.symbol, decimals: tokenB.decimals },
        tokenAMax: pool.leefIsA
          ? `${pool.leef.quantity.toFixed(leefMeta.decimals)} LEEF`
          : `${pool.pair.quantity.toFixed(pairMeta.decimals)} ${pairMeta.symbol}`,
        tokenBMax: pool.leefIsA
          ? `${pool.pair.quantity.toFixed(pairMeta.decimals)} ${pairMeta.symbol}`
          : `${pool.leef.quantity.toFixed(leefMeta.decimals)} LEEF`,
      });
      flash(`Removed ${pct}% of the position · tx ${txid.slice(0, 10)}…`);
      window.setTimeout(() => void positionsQ.refetch(), 5000);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Remove failed", true);
    } finally {
      setBusy(false);
    }
  }

  const poolLiq = Number(pool.liquidity || "0");

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Droplets className="size-4 text-accent" />
            Liquidity on this book
          </h3>
          <p className="text-xs text-muted-foreground">
            Full-range position · deposits both sides at the current reserve
            ratio · fees accrue to the position.
          </p>
        </div>
        <Badge variant="plain">{pool.feePct}% fee tier</Badge>
      </div>

      {!live ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-background p-4">
          <p className="text-xs text-muted-foreground">
            Liquidity positions live on-chain — connect Cloud Wallet / Anchor or
            import a session key to add or remove LP.
          </p>
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            Connect to manage LP
          </Button>
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <div className="mb-1 text-xs text-muted-foreground">LEEF in</div>
            <div className="flex items-center gap-2">
              <Input
                inputMode="decimal"
                value={amountLeef}
                onChange={(e) => setAmountLeef(e.target.value)}
                placeholder="0.0"
                className="h-11 font-mono"
              />
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setAmountLeef(String(Math.floor(balances.LEEF ?? 0)))}
              >
                Max
              </Button>
            </div>
            <div className="mt-2 font-mono text-xs tabular-nums text-muted-foreground">
              ≈ {fmtNum(pairAmount, { digits: 4 })} {pool.pair.symbol} paired
              {leefAmount > 0 && (balances[pool.pair.symbol] ?? 0) < pairAmount
                ? ` — short ${pool.pair.symbol}`
                : ""}
            </div>
            <Button
              variant="leef"
              className="mt-3 w-full"
              disabled={
                busy || !(leefAmount > 0) || !enoughLeef || !enoughPair || snap.source !== "live"
              }
              onClick={() => void onAdd()}
            >
              <Plus className="size-3.5" />
              {busy ? "Signing…" : "Add liquidity (full range)"}
            </Button>
            {leefAmount > 0 && (!enoughLeef || !enoughPair) && (
              <p className="mt-2 text-xs text-warn">Balance too low for this size.</p>
            )}
          </div>

          <div>
            <div className="mb-1 text-xs text-muted-foreground">Your positions here</div>
            {positionsQ.isLoading ? (
              <p className="py-6 text-center text-xs text-muted-foreground">Loading positions…</p>
            ) : positions.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                No open position on pool #{pool.id}.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {positions.map((pos) => {
                  const share = poolLiq > 0 ? Number(pos.liquidity) / poolLiq : 0;
                  const estLeef = share * pool.leef.quantity;
                  const estPair = share * pool.pair.quantity;
                  return (
                    <div
                      key={pos.id}
                      className="rounded-lg border border-border bg-background px-3 py-2 text-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-muted-foreground">#{pos.id}</span>
                        <span className="font-mono tabular-nums">
                          ~{fmtNum(estLeef, { compact: true })} LEEF · ~
                          {fmtNum(estPair, { digits: 2 })} {pool.pair.symbol}
                        </span>
                      </div>
                      {(pos.feesA || pos.feesB) && (
                        <div className="mt-0.5 font-mono text-subtle">
                          unclaimed: {[pos.feesA, pos.feesB].filter(Boolean).join(" + ")}
                        </div>
                      )}
                      <div className="mt-2 flex gap-1.5">
                        {[25, 50, 100].map((pct) => (
                          <Button
                            key={pct}
                            variant="outline"
                            size="xs"
                            disabled={busy}
                            onClick={() => void onRemove(pos, pct)}
                          >
                            <Minus className="size-3" />
                            {pct === 100 ? "Max" : `${pct}%`}
                          </Button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {note && (
        <p className="mt-3 rounded-lg border border-leef/30 bg-leef/10 px-3 py-2 text-xs text-leef">
          {note}
        </p>
      )}
      {err && (
        <p className="mt-3 rounded-lg border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
          {err}
        </p>
      )}
    </Card>
  );
}
