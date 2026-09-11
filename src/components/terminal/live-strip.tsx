import { Pause, Play, Radio } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fmtNum } from "@/lib/leef/format";
import { cn } from "@/lib/utils";
import { useTerminal } from "@/store/terminal";
import type { LiveTickState } from "./use-live-tick";

export function LiveStrip({ tick }: { tick: LiveTickState }) {
  const paused = useTerminal((s) => s.tickPaused);
  const setPaused = useTerminal((s) => s.setTickPaused);
  const setTab = useTerminal((s) => s.setTab);
  const setTickPool = useTerminal((s) => s.setTickPool);
  const lastPrint = tick.prints.find((p) => p.poolId === tick.pool?.id) ?? tick.prints[0];
  const bias = tick.signal.bias;
  const px = lastPrint?.px ?? tick.last;
  const best = tick.bestRoute;
  const swapId = tick.swapPoolId;

  return (
    <div className="border-b border-border bg-surface-2">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-1.5 sm:px-6">
        <button
          type="button"
          onClick={() => setTab("tick")}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-label="Open live tick"
        >
          <span className="hidden items-center gap-1.5 text-xs uppercase tracking-wider text-subtle sm:flex">
            <Radio className="size-3 text-accent" />
            Book
          </span>
          <span
            key={`${lastPrint?.t ?? "px"}-${lastPrint?.poolId ?? 0}`}
            className={cn(
              "rounded-md px-1.5 py-0.5 font-mono text-sm tabular-nums",
              lastPrint?.side === "sell" ? "tick-flash-sell text-sell" : "tick-flash-buy text-buy",
            )}
          >
            {tick.candles.length === 0 ? "—" : fmtNum(px, { digits: 4 })}
            <span className="ml-1 text-xs text-muted-foreground">{tick.unit}</span>
          </span>
          <span
            className={cn(
              "hidden font-mono text-xs tabular-nums sm:inline",
              tick.change >= 0 ? "text-buy" : "text-sell",
            )}
          >
            {tick.change >= 0 ? "+" : ""}
            {(tick.change * 100).toFixed(2)}%
          </span>
          {swapId != null && (
            <Badge variant="accent" className="hidden sm:inline-flex">
              Swap {best?.tokenIn ?? "in"}→{best?.tokenOut ?? "LEEF"} #{swapId}
              {best && best.vsBestPct === 0 ? " · least loss" : ""}
            </Badge>
          )}
          <Badge
            variant={bias === "buy" ? "buy" : bias === "sell" ? "sell" : "plain"}
            className="hidden lg:inline-flex"
          >
            {bias === "buy" ? "AI buy" : bias === "sell" ? "AI sell" : "AI hold"}{" "}
            {Number.isFinite(tick.signal.confidence)
              ? Math.round(tick.signal.confidence * 100)
              : 0}%
          </Badge>
        </button>
        <button
          type="button"
          onClick={() => setPaused(!paused)}
          className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-3 hover:text-fg"
          aria-label={paused ? "Resume ticker" : "Pause ticker"}
        >
          {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
        </button>
      </div>
      <div className="overflow-hidden border-t border-border/70">
        <div
          className={cn(
            "ticker-track flex w-max gap-8 px-4 py-1 text-xs text-muted-foreground",
            paused && "ticker-paused",
          )}
        >
          {[0, 1].flatMap((copy) =>
            tick.prints.map((p, i) => (
              <button
                key={`${copy}-${p.poolId}-${i}`}
                type="button"
                onClick={() => {
                  setTickPool(p.poolId);
                  setTab("tick");
                }}
                className="flex items-center gap-2 font-mono tabular-nums"
              >
                <span className="text-subtle">#{p.poolId}</span>
                <span>{p.pair}</span>
                <span className={p.side === "buy" ? "text-buy" : "text-sell"}>
                  {fmtNum(p.px, { digits: 4 })}
                </span>
                {p.loss != null && (
                  <span className={p.loss <= 0.002 ? "text-leef" : "text-sell"}>
                    {p.loss <= 0.002 ? "least loss" : `−${(p.loss * 100).toFixed(1)}%`}
                  </span>
                )}
                {p.role === "best-buy" && <span className="text-buy">BUY</span>}
                {p.role === "best-sell" && <span className="text-sell">SELL</span>}
              </button>
            )),
          )}
        </div>
      </div>
    </div>
  );
}
