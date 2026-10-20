import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { LiveTape } from "@/components/charts/LiveTape";
import { fmtNum } from "@/lib/leef/format";
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
      <LiveTape trades={snap.trades} fetchedAt={snap.fetchedAt} source={snap.source} />
    </div>
  );
}

