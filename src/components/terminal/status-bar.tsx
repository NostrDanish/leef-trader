import { useEffect, useState } from "react";
import { marketStats } from "@/lib/leef/analytics";
import { fmtLeefLot, fmtNum, fmtUsd, timeAgo } from "@/lib/leef/format";
import { headline } from "@/lib/leef/rank";
import type { LeefSnapshot, RankedPool } from "@/lib/leef/types";
import type { LiveTickState } from "./use-live-tick";
import { useMarketEngine } from "@/hooks/useMarketEngine";
import { cn } from "@/lib/utils";

export function StatusBar({
  snap,
  ranked,
  tick,
}: {
  snap: LeefSnapshot;
  ranked: RankedPool[];
  tick: LiveTickState;
}) {
  const [mounted, setMounted] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => setMounted(true), []);
  // Live infra pulse (head block age etc.) between engine commits.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const engine = useMarketEngine();
  const h = headline(ranked);
  const stats = marketStats(snap);
  const synced = mounted ? timeAgo(snap.fetchedAt) : "just now";
  const blockAgeSec =
    engine.headBlockAt > 0 ? Math.max(0, (now - engine.headBlockAt) / 1000) : null;
  const blockFresh = blockAgeSec != null && blockAgeSec < 5;
  const bestRpc = engine.rpc[0];
  const spotAgeMs = engine.snapshot?.spotAt ? now - Date.parse(engine.snapshot.spotAt) : null;
  const route = tick.bestRoute;
  const conversion = route && route.amountIn > 0 ? route.amountOut / route.amountIn : 0;

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
          <span className="text-border">·</span>
          <span className="font-mono tabular-nums">
            1 LEEF <strong className="text-fg">{fmtUsd(snap.leefUsd)}</strong>
          </span>
          <span className="font-mono tabular-nums">
            10M <strong className="text-wax">{fmtLeefLot(snap.waxPerLeef, 4)} WAX</strong>
          </span>
          <span className="font-mono tabular-nums">
            WAX <strong className="text-fg">${fmtNum(snap.waxUsd, { digits: 5 })}</strong>
          </span>
          {route && (
            <span className="hidden font-mono tabular-nums text-accent xl:inline">
              {route.tokenIn}→{route.tokenOut} · 1 = {fmtNum(conversion, { compact: true, digits: 5 })}
            </span>
          )}
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
          <span
            className="font-mono tabular-nums"
            title={`Head block · best RPC ${bestRpc ? bestRpc.url : "—"} (${bestRpc ? `${Math.round(bestRpc.latencyMs ?? 0)}ms` : "—"})`}
          >
            <span className={blockFresh ? "text-leef" : "text-warn"}>●</span> WAX{" "}
            {blockAgeSec != null ? (
              <span className={cn(blockFresh ? "text-fg" : "text-warn")}>
                #{fmtNum(engine.headBlock, { digits: 0 })} · {blockAgeSec.toFixed(1)}s
              </span>
            ) : (
              <span className="text-warn">connecting…</span>
            )}
          </span>
          {spotAgeMs != null && spotAgeMs < 30_000 && (
            <span className="hidden font-mono tabular-nums text-accent md:inline">
              ◆ chain spot {(spotAgeMs / 1000).toFixed(0)}s
            </span>
          )}
          <span
            className="font-mono"
            title={
              engine.signer.mode === "live"
                ? `Signer ready (${engine.signer.authType ?? "wallet"}) — market updates never re-import it`
                : "Paper mode — no signer"
            }
          >
            <span className={engine.signer.ready ? "text-leef" : "text-subtle"}>●</span>{" "}
            {engine.signer.mode === "live" ? "signer" : "paper"}
          </span>
          <span className="font-mono" title={`Auto trade ${engine.autoTrade.bot ? "active" : "off"} · phase ${engine.autoTrade.phase}`}>
            <span className={engine.autoTrade.bot ? "text-leef" : "text-subtle"}>●</span>{" "}
            {engine.autoTrade.bot ? "auto" : "idle"}
          </span>
          <span className="font-mono tabular-nums">
            Synced <span className="text-fg">{synced}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
