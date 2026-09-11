import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { fmtNum, fmtUsd, shortHash } from "@/lib/leef/format";
import type { LeefSnapshot } from "@/lib/leef/types";
import { cn } from "@/lib/utils";

export function Tape({ snap }: { snap: LeefSnapshot }) {
  const [filter, setFilter] = useState<number | "all">("all");
  const poolIds = useMemo(() => {
    const ids = [...new Set(snap.trades.map((t) => t.poolId))];
    return ids;
  }, [snap.trades]);

  const rows = useMemo(() => {
    const src =
      filter === "all" ? snap.trades : snap.trades.filter((t) => t.poolId === filter);
    return [...src].sort((a, b) => b.timestamp - a.timestamp).slice(0, 40);
  }, [snap.trades, filter]);

  const buyUsd = rows.filter((t) => t.type === "buy").reduce((s, t) => s + t.usdVolume, 0);
  const sellUsd = rows.filter((t) => t.type === "sell").reduce((s, t) => s + t.usdVolume, 0);

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-medium">Tape</h2>
          <p className="text-xs text-muted-foreground">
            Recent on-chain swaps from the most active LEEF books.
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
          No swaps in this snapshot. Refresh to pull the live Alcor tape.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
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
                      {t.type === "buy" ? "Buy LEEF" : "Sell LEEF"}
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
    </Card>
  );
}
