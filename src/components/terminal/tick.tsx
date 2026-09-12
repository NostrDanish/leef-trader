import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MIN_LEEF_BACKING } from "@/lib/leef/amm";
import { fmtNum, fmtPct, fmtUsd } from "@/lib/leef/format";
import type { LeefSnapshot } from "@/lib/leef/types";
import { cn } from "@/lib/utils";
import { useTerminal } from "@/store/terminal";
import { PairMarks } from "./token-mark";
import type { LiveTickState } from "./use-live-tick";

/** Static market desk: authoritative prices/routes only, no synthetic chart. */
export function TickDesk({ snap, tick }: { snap: LeefSnapshot; tick: LiveTickState }) {
  const tickPoolId = useTerminal((s) => s.tickPoolId);
  const setTickPool = useTerminal((s) => s.setTickPool);
  const setTab = useTerminal((s) => s.setTab);
  const tokenIn = useTerminal((s) => s.tokenIn);
  const tokenOut = useTerminal((s) => s.tokenOut);
  const amountIn = useTerminal((s) => s.amountIn);
  const best = tick.bestRoute;
  const swapId = tick.swapPoolId;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-base font-medium tracking-tight">Current market</h2>
          <p className="text-xs text-muted-foreground">
            Authoritative Alcor/on-chain pool state. No simulated movement or animated
            prices—the desk changes only when real market data changes.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setTab("quotes")}>
          Open route terminal
          <ArrowRight className="size-3.5" />
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-l-2 border-l-accent p-4">
          <div className="text-xs uppercase tracking-wider text-subtle">LEEF price</div>
          <div className="mt-1 font-mono text-xl tabular-nums text-fg">
            {fmtUsd(snap.leefUsd)}
          </div>
          <div className="mt-2 font-mono text-xs text-muted-foreground">
            10M = {fmtNum(snap.waxPerLeef * 10_000_000, { digits: 4 })} WAX
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase tracking-wider text-subtle">WAX price</div>
          <div className="mt-1 font-mono text-xl tabular-nums text-wax">
            {fmtUsd(snap.waxUsd, 5)}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            {snap.spotAt ? "Direct on-chain spot active" : "Market snapshot"}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase tracking-wider text-subtle">Best current route</div>
          <div className="mt-1 font-mono text-base text-accent">
            {best ? `${best.tokenIn} → ${best.tokenOut}` : "No route"}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            {best
              ? `${fmtNum(Number(amountIn) || 0, { compact: true })} → ${fmtNum(best.amountOut, { compact: true })} · ${best.kind}`
              : "Waiting for a supported pair"}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase tracking-wider text-subtle">Backed pools</div>
          <div className="mt-1 font-mono text-xl tabular-nums">{tick.books.length}</div>
          <div className="mt-2 text-xs text-muted-foreground">
            ≥ {fmtNum(MIN_LEEF_BACKING, { compact: true })} LEEF backing
          </div>
        </Card>
      </div>

      {best && swapId != null && (
        <Card className="border-accent/30 bg-accent/5 p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-accent">
                Best modeled route · {tokenIn} → {tokenOut}
              </div>
              <p className="mt-1 text-sm">
                {best.label}. Fill {fmtNum(best.amountOut, { compact: true })} {tokenOut} for{" "}
                {fmtNum(Number(amountIn) || 0, { compact: true })} {tokenIn}. Impact{" "}
                {fmtPct(best.priceImpact, 2, false)}, fee {best.feePct.toFixed(2)}%.
              </p>
              <p className="mt-1 text-xs text-subtle">
                A fresh venue-specific executable quote is still required before signing.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setTab("quotes")}>
              Compare all routes
              <ArrowRight className="size-3.5" />
            </Button>
          </div>
        </Card>
      )}

      <Card className="p-4 sm:p-5">
        <div className="mb-3">
          <h3 className="text-sm font-medium">Backed pool prices</h3>
          <p className="text-xs text-muted-foreground">
            Static current values from the latest authoritative market state.
          </p>
        </div>
        {tick.books.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No LEEF pool currently holds ≥ {fmtNum(MIN_LEEF_BACKING, { compact: true })} LEEF.
          </p>
        ) : (
          <div className="-mx-4 min-w-0 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[680px] text-left text-xs">
              <thead className="text-subtle">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3 font-medium">Book</th>
                  <th className="py-2 pr-3 font-medium">LEEF backing</th>
                  <th className="py-2 pr-3 font-medium">Pair / 10M LEEF</th>
                  <th className="py-2 pr-3 font-medium">USD / 10M</th>
                  <th className="py-2 pr-3 font-medium">Buy</th>
                  <th className="py-2 font-medium">Sell</th>
                </tr>
              </thead>
              <tbody>
                {tick.books.map((b) => {
                  const selected = tickPoolId === b.pool.id;
                  return (
                    <tr
                      key={b.pool.id}
                      className={cn(
                        "border-b border-border/70",
                        selected && "bg-accent/5",
                      )}
                    >
                      <td className="py-2.5 pr-3">
                        <button
                          type="button"
                          onClick={() => setTickPool(b.pool.id)}
                          className="flex items-center gap-2 text-left"
                        >
                          <PairMarks pair={b.pool.pair.symbol} />
                          <span className="font-mono">
                            {b.pool.pair.symbol} #{b.pool.id}
                          </span>
                          {b.bestBuy && <Badge variant="buy">Buy</Badge>}
                          {b.bestSell && <Badge variant="sell">Sell</Badge>}
                        </button>
                      </td>
                      <td className="py-2.5 pr-3 font-mono tabular-nums">
                        {fmtNum(b.leefBacking, { compact: true })}
                      </td>
                      <td className="py-2.5 pr-3 font-mono tabular-nums">
                        {fmtNum(b.pairPerMillion * 10, { digits: 4 })} {b.pool.pair.symbol}
                      </td>
                      <td className="py-2.5 pr-3 font-mono tabular-nums">
                        {fmtUsd(b.usdPerMillion * 10)}
                      </td>
                      <td className={cn("py-2.5 pr-3 font-mono", b.bestBuy ? "text-buy" : "text-muted-foreground")}>
                        {b.buy ? `${fmtPct(b.buy.impact, 2, false)} impact` : "—"}
                      </td>
                      <td className={cn("py-2.5 font-mono", b.bestSell ? "text-buy" : "text-muted-foreground")}>
                        {b.sell ? `${fmtPct(b.sell.impact, 2, false)} impact` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
