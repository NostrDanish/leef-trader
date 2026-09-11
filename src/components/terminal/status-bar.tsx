import { useEffect, useState } from "react";
import { marketStats } from "@/lib/leef/analytics";
import { fmtNum, timeAgo } from "@/lib/leef/format";
import { headline } from "@/lib/leef/rank";
import type { LeefSnapshot, RankedPool } from "@/lib/leef/types";

export function StatusBar({
  snap,
  ranked,
  countdown,
}: {
  snap: LeefSnapshot;
  ranked: RankedPool[];
  countdown: number;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const h = headline(ranked);
  const stats = marketStats(snap);
  const synced = mounted ? timeAgo(snap.fetchedAt) : "just now";

  return (
    <div className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="relative flex size-2">
            <span
              className={`absolute inline-flex h-full w-full rounded-full opacity-70 ${snap.source === "live" ? "animate-ping bg-leef" : "bg-warn"}`}
            />
            <span
              className={`relative inline-flex size-2 rounded-full ${snap.source === "live" ? "bg-leef" : "bg-warn"}`}
            />
          </span>
          <span>
            TVL{" "}
            <strong className="font-mono tabular-nums text-fg">
              ${fmtNum(stats.tvlUsd, { digits: 0 })}
            </strong>
          </span>
          <span className="text-border">·</span>
          <span>
            24h{" "}
            <strong className="font-mono tabular-nums text-fg">
              ${fmtNum(stats.volume24Usd, { digits: 0 })}
            </strong>
          </span>
          <span className="text-border">·</span>
          <span>
            Locked{" "}
            <strong className="font-mono tabular-nums text-fg">
              {fmtNum(stats.leefLocked, { compact: true })} LEEF
            </strong>
          </span>
          {h.bestBuy && (
            <>
              <span className="text-border">·</span>
              <span>
                Swap to{" "}
                <strong className="font-mono tabular-nums text-fg">
                  #{h.bestBuy.id} {h.bestBuy.pair.symbol}
                </strong>
              </span>
            </>
          )}
          {h.arb && (
            <>
              <span className="text-border">·</span>
              <span className="text-warn">
                Spread {fmtNum(h.arb.spreadPct * 100, { digits: 1 })}% · #{h.arb.cheap.id} vs #
                {h.arb.rich.id}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span>
            Synced {synced} · refresh in{" "}
            <span className="font-mono tabular-nums text-accent">{countdown}s</span>
          </span>
        </div>
      </div>
    </div>
  );
}
