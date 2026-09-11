import { ArrowDownWideNarrow, ArrowUpNarrowWide, Search } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { sumBy } from "@/lib/leef/analytics";
import { fmtNum, fmtPct, fmtUsd } from "@/lib/leef/format";
import type { RankedPool, TradeBadge } from "@/lib/leef/types";
import { cn } from "@/lib/utils";
import { useTerminal } from "@/store/terminal";
import { PairMarks } from "./token-mark";

const BADGE_COPY: Record<
  TradeBadge,
  { label: string; variant: "leef" | "accent" | "wax" | "warn" | "sell" | "buy" }
> = {
  "best-buy": { label: "Best buy", variant: "buy" },
  "best-sell": { label: "Best sell", variant: "accent" },
  deepest: { label: "Deepest", variant: "leef" },
  "most-traded": { label: "Most traded", variant: "wax" },
  mispriced: { label: "Mispriced", variant: "warn" },
  thin: { label: "Thin", variant: "sell" },
};

export function PoolsTable({ ranked }: { ranked: RankedPool[] }) {
  const query = useTerminal((s) => s.poolQuery);
  const sort = useTerminal((s) => s.poolSort);
  const dir = useTerminal((s) => s.poolDir);
  const setQuery = useTerminal((s) => s.setPoolQuery);
  const setSort = useTerminal((s) => s.setPoolSort);
  const toggleDir = useTerminal((s) => s.togglePoolDir);
  const selectPool = useTerminal((s) => s.selectPool);
  const selected = useTerminal((s) => s.selectedPoolId);
  const [hideThin, setHideThin] = useState(true);

  const q = query.trim().toLowerCase();
  let rows = ranked.filter(
    (p) =>
      !q ||
      p.pair.symbol.toLowerCase().includes(q) ||
      p.pair.contract.toLowerCase().includes(q) ||
      String(p.id).includes(q),
  );
  if (hideThin) {
    rows = rows.filter((p) => !p.badges.includes("thin") || p.volume24Usd >= 1);
  }

  rows = [...rows].sort((a, b) => {
    const key = sort;
    let va: number | string = 0;
    let vb: number | string = 0;
    if (key === "score") {
      va = a.tradeScore;
      vb = b.tradeScore;
    } else if (key === "tvl") {
      va = a.tvlUsd;
      vb = b.tvlUsd;
    } else if (key === "volume") {
      va = a.volume24Usd;
      vb = b.volume24Usd;
    } else if (key === "reserve") {
      va = a.leef.quantity;
      vb = b.leef.quantity;
    } else if (key === "price") {
      va = a.waxPerLeef ?? 0;
      vb = b.waxPerLeef ?? 0;
    } else if (key === "fee") {
      va = a.feePct;
      vb = b.feePct;
    } else if (key === "change") {
      va = a.change24;
      vb = b.change24;
    } else if (key === "apy") {
      va = a.feeApyPct;
      vb = b.feeApyPct;
    } else if (key === "turnover") {
      va = a.turnover;
      vb = b.turnover;
    } else {
      va = a.pair.symbol;
      vb = b.pair.symbol;
    }
    if (va < vb) return dir === "asc" ? -1 : 1;
    if (va > vb) return dir === "asc" ? 1 : -1;
    return 0;
  });

  const tvl = sumBy(ranked, (p) => p.tvlUsd);
  const vol = sumBy(ranked, (p) => p.volume24Usd);
  const top = [...ranked].sort((a, b) => b.tvlUsd - a.tvlUsd)[0];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="LEEF pairs" value={String(ranked.length)} />
        <Stat label="Combined TVL" value={fmtUsd(tvl, 0)} />
        <Stat label="Combined 24h" value={fmtUsd(vol, 0)} />
        <Stat
          label="Dominant book"
          value={top ? `LEEF / ${top.pair.symbol}` : "—"}
        />
      </div>

      <Card className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search pair, contract, pool id"
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={hideThin ? "secondary" : "outline"}
              size="sm"
              onClick={() => setHideThin((v) => !v)}
            >
              {hideThin ? "Thin hidden" : "Showing thin"}
            </Button>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
              className="h-11 rounded-md border border-border bg-bg px-3 text-xs text-fg"
            >
              <option value="tvl">TVL</option>
              <option value="volume">24h volume</option>
              <option value="apy">Fee APY</option>
              <option value="turnover">Turnover</option>
              <option value="change">24h change</option>
              <option value="score">Trade score</option>
              <option value="reserve">LEEF reserve</option>
              <option value="price">WAX per LEEF</option>
              <option value="fee">Fee</option>
              <option value="name">Pair</option>
            </select>
            <Button variant="secondary" size="icon" onClick={toggleDir} aria-label="Toggle sort">
              {dir === "desc" ? (
                <ArrowDownWideNarrow className="size-4" />
              ) : (
                <ArrowUpNarrowWide className="size-4" />
              )}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead>
              <tr className="border-b border-border text-subtle">
                <th className="px-4 py-3 font-medium">Pair</th>
                <th className="px-3 py-3 font-medium">24h</th>
                <th className="px-3 py-3 font-medium">WAX / 1M</th>
                <th className="px-3 py-3 font-medium">Volume</th>
                <th className="px-3 py-3 font-medium">TVL</th>
                <th className="px-3 py-3 font-medium">Fee APY</th>
                <th className="px-3 py-3 font-medium">Turnover</th>
                <th className="px-3 py-3 font-medium">Tags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => selectPool(p.id)}
                  className={cn(
                    "cursor-pointer border-b border-border/70 hover:bg-surface-2",
                    selected === p.id && "bg-accent/5",
                  )}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <PairMarks pair={p.pair.symbol} />
                      <div>
                        <div className="font-medium text-fg">
                          LEEF / {p.pair.symbol}
                        </div>
                        <div className="font-mono text-subtle">
                          {p.pair.contract} · #{p.id} · {p.feePct}%
                        </div>
                      </div>
                    </div>
                  </td>
                  <td
                    className={cn(
                      "px-3 py-3 font-mono tabular-nums",
                      p.change24 >= 0 ? "text-buy" : "text-sell",
                    )}
                  >
                    {p.change24 >= 0 ? "+" : ""}
                    {p.change24.toFixed(2)}%
                  </td>
                  <td className="px-3 py-3 font-mono tabular-nums">
                    {p.waxPerMillionLeef != null
                      ? fmtNum(p.waxPerMillionLeef, { digits: 2 })
                      : "—"}
                    {p.vsMedianWaxPct != null && Math.abs(p.vsMedianWaxPct) > 0.03 && (
                      <div
                        className={cn(
                          "text-xs",
                          p.vsMedianWaxPct > 0 ? "text-warn" : "text-leef",
                        )}
                      >
                        {fmtPct(p.vsMedianWaxPct, 1)} vs median
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3 font-mono tabular-nums">
                    {fmtUsd(p.volume24Usd, 2)}
                  </td>
                  <td className="px-3 py-3 font-mono tabular-nums text-accent">
                    {fmtUsd(p.tvlUsd, 2)}
                  </td>
                  <td className="px-3 py-3 font-mono tabular-nums">
                    {fmtNum(p.feeApyPct, { digits: 1 })}%
                  </td>
                  <td className="px-3 py-3 font-mono tabular-nums text-muted-foreground">
                    {fmtNum(p.turnover * 100, { digits: 1 })}%
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1">
                      {p.badges.map((b) => (
                        <Badge key={b} variant={BADGE_COPY[b].variant}>
                          {BADGE_COPY[b].label}
                        </Badge>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No LEEF pools match “{query}”.
          </div>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wider text-subtle">{label}</div>
      <div className="mt-1 truncate font-mono text-lg tabular-nums">{value}</div>
    </Card>
  );
}
