import { useEffect, useState } from "react";
import { marketStats } from "@/lib/leef/analytics";
import { fmtNum, timeAgo } from "@/lib/leef/format";
import { headline } from "@/lib/leef/rank";
import type { LeefSnapshot, RankedPool } from "@/lib/leef/types";
import { cn } from "@/lib/utils";
import {
  clampSyncSec,
  DEFAULT_SYNC_SEC,
  MAX_SYNC_SEC,
  MIN_SYNC_SEC,
  SYNC_PRESETS,
  useTerminal,
} from "@/store/terminal";

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
  const syncSec = useTerminal((s) => clampSyncSec(s.syncSec ?? DEFAULT_SYNC_SEC));
  const setSyncSec = useTerminal((s) => s.setSyncSec);

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
              <span className="hidden text-border sm:inline">·</span>
              <span className="hidden sm:inline">
                Swap to{" "}
                <strong className="font-mono tabular-nums text-fg">
                  #{h.bestBuy.id} {h.bestBuy.pair.symbol}
                </strong>
              </span>
            </>
          )}
          {h.arb && (
            <>
              <span className="hidden text-border lg:inline">·</span>
              <span className="hidden text-warn lg:inline">
                Spread {fmtNum(h.arb.spreadPct * 100, { digits: 1 })}% · #{h.arb.cheap.id} vs #
                {h.arb.rich.id}
              </span>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="flex items-center gap-2">
            <span className="text-subtle">Sync</span>
            <select
              className="h-7 rounded-md border border-border bg-background px-1.5 font-mono text-xs text-foreground"
              value={syncSec}
              onChange={(e) => setSyncSec(Number(e.target.value))}
              aria-label="Book sync interval"
            >
              {SYNC_PRESETS.map((p) => (
                <option key={p.sec} value={p.sec}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <input
            type="range"
            className="w-24 accent-teal-300 sm:w-32"
            min={MIN_SYNC_SEC}
            max={MAX_SYNC_SEC}
            step={1}
            value={syncSec}
            onChange={(e) => setSyncSec(Number(e.target.value))}
            aria-label="Book sync interval in seconds"
          />
          <span>
            Synced {synced} ·{" "}
            <span className={cn("font-mono tabular-nums", syncSec <= 10 ? "text-leef" : "text-accent")}>
              {syncSec <= 10 ? "live" : `${countdown}s`}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
