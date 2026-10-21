import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { fmtNum, fmtUsd, shortHash } from "@/lib/leef/format";
import type { LiveTrade } from "@/lib/leef/types";
import { cn } from "@/lib/utils";
import { FreshnessNote } from "./chart-state";

/**
 * Live tape — real on-chain fills from the snapshot's Alcor swaps pull.
 * Every row links its transaction on waxblock. When the upstream tape is
 * empty the panel says so; it never invents prints.
 */
export function LiveTape({
  trades,
  fetchedAt,
  source,
}: {
  trades: LiveTrade[];
  /** ISO timestamp of the snapshot that carried these fills. */
  fetchedAt: string;
  /** Snapshot provenance ("live" | "fallback" | seed) — shown honestly. */
  source: string;
}) {
  const [filter, setFilter] = useState<number | "all">("all");
  const poolIds = useMemo(() => [...new Set(trades.map((t) => t.poolId))], [trades]);

  const rows = useMemo(() => {
    const src = filter === "all" ? trades : trades.filter((t) => t.poolId === filter);
    return [...src].sort((a, b) => b.timestamp - a.timestamp).slice(0, 40);
  }, [trades, filter]);

  const buyUsd = rows.filter((t) => t.type === "buy").reduce((s, t) => s + t.usdVolume, 0);
  const sellUsd = rows.filter((t) => t.type === "sell").reduce((s, t) => s + t.usdVolume, 0);

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-medium">Live tape</h2>
          <p className="text-xs text-muted-foreground">
            Real fills from the most active LEEF books — every print links its transaction.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs",
              filter === "all"
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-border text-muted-foreground hover:text-fg",
            )}
          >
            All
          </button>
          {poolIds.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs font-mono",
                filter === id
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-border text-muted-foreground hover:text-fg",
              )}
            >
              #{id}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 grid grid-cols-3 gap-3 text-xs">
        <div className="rounded-md border border-border bg-bg px-3 py-2">
          <div className="text-subtle">Prints</div>
          <div className="font-mono tabular-nums">{rows.length}</div>
        </div>
        <div className="rounded-md border border-border bg-bg px-3 py-2">
          <div className="text-subtle">Buy LEEF</div>
          <div className="font-mono tabular-nums text-buy">{fmtUsd(buyUsd, 2)}</div>
        </div>
        <div className="rounded-md border border-border bg-bg px-3 py-2">
          <div className="text-subtle">Sell LEEF</div>
          <div className="font-mono tabular-nums text-sell">{fmtUsd(sellUsd, 2)}</div>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No recent fills — the upstream tape returned no swaps for this window.
        </p>
      ) : (
        <div className="-mx-4 min-w-0 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[680px] text-left text-xs">
            <thead>
              <tr className="border-b border-border text-subtle">
                <th className="py-2 pr-3 font-medium">Time</th>
                <th className="py-2 pr-3 font-medium">Pool</th>
                <th className="py-2 pr-3 font-medium">Side</th>
                <th className="py-2 pr-3 font-medium">Price</th>
                <th className="py-2 pr-3 font-medium">LEEF</th>
                <th className="py-2 pr-3 font-medium">Pair</th>
                <th className="py-2 pr-3 font-medium">USD</th>
                <th className="py-2 text-right font-medium">Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t, i) => (
                <tr key={`${t.txHash}-${i}`} className="border-b border-border/60">
                  <td className="py-2.5 pr-3 font-mono tabular-nums text-muted-foreground">
                    {new Date(t.timestamp).toLocaleTimeString()}
                  </td>
                  <td className="py-2.5 pr-3">
                    #{t.poolId} {t.pair}
                  </td>
                  <td className="py-2.5 pr-3">
                    <Badge variant={t.type === "buy" ? "buy" : "sell"}>
                      {t.type === "buy" ? "Buy LEEF" : t.type === "sell" ? "Sell LEEF" : "LP"}
                    </Badge>
                  </td>
                  <td className="py-2.5 pr-3 font-mono tabular-nums">
                    {fmtNum(t.priceWax, { digits: 8 })}
                  </td>
                  <td className="py-2.5 pr-3 font-mono tabular-nums text-leef">
                    {fmtNum(t.amountLeef, { compact: true })}
                  </td>
                  <td className="py-2.5 pr-3 font-mono tabular-nums text-wax">
                    {fmtNum(t.amountPair, { digits: 2 })} {t.pairSymbol}
                  </td>
                  <td className="py-2.5 pr-3 font-mono tabular-nums">
                    {fmtUsd(t.usdVolume, 2)}
                  </td>
                  <td className="py-2.5 text-right">
                    <a
                      className="font-mono text-accent hover:underline"
                      href={`https://waxblock.io/transaction/${t.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortHash(t.txHash)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex justify-end">
        <FreshnessNote
          fetchedAt={Date.parse(fetchedAt)}
          source={`Alcor swaps API · snapshot ${source}`}
        />
      </div>
    </Card>
  );
}
