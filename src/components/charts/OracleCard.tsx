import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { fetchWaxUsd, type WaxUsdPrice } from "@/lib/market/oracle";
import { fmtNum, fmtUsd } from "@/lib/leef/format";
import type { LeefSnapshot } from "@/lib/leef/types";
import { cn } from "@/lib/utils";
import { relTime, useNow } from "@/components/terminal/use-now";

const ORACLE_SOURCE: Record<WaxUsdPrice["source"], string> = {
  delphioracle: "delphioracle on-chain",
  alcor: "Alcor token API",
};

/**
 * Live oracle card: WAXP/USD from the oracle contract lib (Delphi on-chain
 * median, Alcor fallback) plus the LEEF price from the current snapshot.
 * Every figure is source-attributed with a last-updated line; a failed
 * oracle read shows an explicit unavailable state, never a stale number
 * dressed as live.
 */
export function OracleCard({ snap }: { snap: LeefSnapshot }) {
  const now = useNow(5000);
  const q = useQuery({
    queryKey: ["wax-usd-oracle"],
    queryFn: () => fetchWaxUsd(),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1,
  });

  const leefLive = snap.source === "live";

  return (
    <Card className="flex flex-col gap-4 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Price oracle</h2>
          <p className="text-xs text-muted-foreground">
            Live anchors the engine trades against.
          </p>
        </div>
        <span
          className={cn(
            "mt-0.5 inline-flex items-center gap-1.5 font-mono text-[11px]",
            q.data ? "text-leef" : "text-subtle",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              q.data && "animate-pulse",
              q.data ? "bg-leef" : "bg-subtle",
            )}
          />
          {q.data ? "live" : q.isPending ? "…" : "unavailable"}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-bg px-3 py-2.5">
          <div className="text-[11px] uppercase tracking-wider text-subtle">WAX / USD</div>
          {q.isPending ? (
            <div className="mt-1.5 h-6 w-24 animate-pulse rounded bg-surface-2" />
          ) : q.isError ? (
            <div className="mt-1 text-sm text-warn">unavailable</div>
          ) : (
            <div className="mt-1 font-mono text-lg tabular-nums text-fg">
              ${fmtNum(q.data.usd, { digits: 5 })}
            </div>
          )}
          <div className="mt-1 font-mono text-[11px] text-subtle">
            {q.data
              ? `${ORACLE_SOURCE[q.data.source]} · ${relTime(q.data.fetchedAt, now)}`
              : q.isError
                ? "oracle read failed — no cached value shown"
                : "reading oracle…"}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-bg px-3 py-2.5">
          <div className="text-[11px] uppercase tracking-wider text-subtle">1 LEEF</div>
          <div className="mt-1 font-mono text-lg tabular-nums text-fg">{fmtUsd(snap.leefUsd)}</div>
          <div className="mt-1 font-mono text-[11px] text-subtle">
            {leefLive ? "Alcor live book" : "cached book — not live"} ·{" "}
            {relTime(snap.fetchedAt, now)}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
        <span>
          10M LEEF{" "}
          <strong className="text-fg">{fmtUsd(snap.leefUsd * 10_000_000)}</strong>
        </span>
        <span>
          <strong className="text-wax">{fmtNum(snap.waxPerLeef * 1e7, { digits: 4 })} WAX</strong>{" "}
          / 10M
        </span>
      </div>
    </Card>
  );
}
