import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { fmtNum, fmtUsd, shortHash } from "@/lib/leef/format";
import type { LeefSnapshot } from "@/lib/leef/types";
import { marketBus } from "@/lib/market/event-bus";
import { swapFlow, type PoolFlowState } from "@/lib/market/swap-flow";
import { useTerminal } from "@/store/terminal";
import { cn } from "@/lib/utils";

function fmtAge(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1_000) return "now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * E-1 swap-flow panel: per-pool rolling state from the Hyperion logswap
 * stream (market data — the danger guard kill-switch lives top right).
 */
function FlowPanel({ snap }: { snap: LeefSnapshot }) {
  const [states, setStates] = useState<PoolFlowState[]>(() =>
    swapFlow.tracker.allStates(Date.now()),
  );
  const flowGuardEnabled = useTerminal((s) => s.flowGuardEnabled);
  const setFlowGuardEnabled = useTerminal((s) => s.setFlowGuardEnabled);

  useEffect(() => {
    const off = marketBus.on("flow", (p) => setStates(p.states));
    // Ages/volume rates move even between polls — repaint on a slow tick.
    const timer = setInterval(() => setStates(swapFlow.tracker.allStates(Date.now())), 5_000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);

  const labels = useMemo(() => {
    const m = new Map<number, { pair: string; quote: string }>();
    for (const p of snap.pools) m.set(p.id, { pair: `LEEF/${p.pair.symbol}`, quote: p.pair.symbol });
    for (const p of snap.aux) {
      m.set(p.id, { pair: `${p.tokenA.symbol}/${p.tokenB.symbol}`, quote: p.tokenB.symbol });
    }
    return m;
  }, [snap.pools, snap.aux]);

  const rows = states.filter((s) => s.swapsInWindow > 0).slice(0, 12);

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-medium">Swap flow</h2>
          <p className="text-xs text-muted-foreground">
            Live Hyperion logswap stream, 5-minute rolling window — market data only.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setFlowGuardEnabled(!flowGuardEnabled)}
          title="Flow may raise the danger score (veto/size-down entries). It never creates an entry."
          className={cn(
            "rounded-md border px-2.5 py-1 text-xs",
            flowGuardEnabled
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-border text-muted-foreground hover:text-fg",
          )}
        >
          Danger guard {flowGuardEnabled ? "on" : "off"}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No logswap flow observed yet — the poller fills this within a minute on a live book.
        </p>
      ) : (
        <div className="-mx-4 min-w-0 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead>
              <tr className="border-b border-border text-subtle">
                <th className="py-2 pr-3 font-medium">Pool</th>
                <th className="py-2 pr-3 font-medium">Swaps</th>
                <th className="py-2 pr-3 font-medium">Imbalance</th>
                <th className="py-2 pr-3 font-medium">Vol/min</th>
                <th className="py-2 pr-3 font-medium">Largest</th>
                <th className="py-2 text-right font-medium">Last swap</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const meta = labels.get(s.poolId);
                const imb = s.imbalancePct;
                return (
                  <tr key={s.poolId} className="border-b border-border/60">
                    <td className="py-2.5 pr-3">
                      #{s.poolId} {meta?.pair ?? ""}
                    </td>
                    <td className="py-2.5 pr-3 font-mono tabular-nums">{s.swapsInWindow}</td>
                    <td
                      className={cn(
                        "py-2.5 pr-3 font-mono tabular-nums",
                        imb > 20 ? "text-buy" : imb < -20 ? "text-sell" : "text-muted-foreground",
                      )}
                    >
                      {imb >= 0 ? "+" : ""}
                      {imb.toFixed(0)}% {imb >= 20 ? "buy" : imb <= -20 ? "sell" : ""}
                    </td>
                    <td className="py-2.5 pr-3 font-mono tabular-nums">
                      {fmtNum(s.volumeQuotePerMin, { digits: 2 })} {meta?.quote ?? ""}
                    </td>
                    <td className="py-2.5 pr-3 font-mono tabular-nums">
                      {fmtNum(s.largestSwapQuote, { digits: 2 })} {meta?.quote ?? ""}
                    </td>
                    <td className="py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                      {fmtAge(s.lastSwapAgeMs)} ago
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function Tape({ snap }: { snap: LeefSnapshot }) {
  return (
    <div className="flex flex-col gap-4">
      <FlowPanel snap={snap} />
      <TapeTable snap={snap} />
    </div>
  );
}

function TapeTable({ snap }: { snap: LeefSnapshot }) {
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
