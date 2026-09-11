import { useEffect, useState } from "react";
import { ArrowRight, Pause, Play, RotateCcw, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { MIN_LEEF_BACKING } from "@/lib/leef/amm";
import { INDICATORS } from "@/lib/leef/indicators";
import { fmtNum, fmtPct, fmtUsd } from "@/lib/leef/format";
import { TICK_PRESETS } from "@/lib/leef/tick-engine";
import type { LeefSnapshot } from "@/lib/leef/types";
import { cn } from "@/lib/utils";
import { useTerminal } from "@/store/terminal";
import { MacdPane, PriceChart, RsiPane } from "./tick-chart";
import { PairMarks } from "./token-mark";
import type { LiveTickState } from "./use-live-tick";

export function TickDesk({ snap, tick }: { snap: LeefSnapshot; tick: LiveTickState }) {
  const knobs = useTerminal((s) => s.tick);
  const setTick = useTerminal((s) => s.setTick);
  const toggleEngine = useTerminal((s) => s.toggleEngine);
  const resetTick = useTerminal((s) => s.resetTick);
  const paused = useTerminal((s) => s.tickPaused);
  const setPaused = useTerminal((s) => s.setTickPaused);
  const tickPoolId = useTerminal((s) => s.tickPoolId);
  const setTickPool = useTerminal((s) => s.setTickPool);
  const setTab = useTerminal((s) => s.setTab);
  const tokenIn = useTerminal((s) => s.tokenIn);
  const tokenOut = useTerminal((s) => s.tokenOut);
  const amountIn = useTerminal((s) => s.amountIn);
  const last = tick.candles[tick.candles.length - 1];
  const usd = tick.pool?.usdPerLeef ?? snap.leefUsd;
  const best = tick.bestRoute;
  const swapId = tick.swapPoolId;
  const [slidersOn, setSlidersOn] = useState(false);
  useEffect(() => setSlidersOn(true), []);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-base font-medium tracking-tight">Live tick</h2>
          <p className="text-xs text-muted-foreground">
            30s Alcor pull of every LEEF book with ≥ {fmtNum(MIN_LEEF_BACKING, { compact: true })}{" "}
            LEEF backing — including non-WAX. Loss is vs the best routed fill.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {TICK_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setTick(p.patch)}
              className="h-9 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-surface-2 hover:text-fg"
            >
              {p.label}
            </button>
          ))}
          <Button variant="secondary" size="sm" onClick={resetTick}>
            <RotateCcw className="size-3.5" />
            Reset
          </Button>
          <Button
            variant={paused ? "default" : "outline"}
            size="sm"
            onClick={() => setPaused(!paused)}
          >
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            {paused ? "Resume" : "Pause"}
          </Button>
        </div>
      </div>

      {best && swapId != null && (
        <Card className="border-accent/30 bg-accent/5 p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-accent">
                Least loss · {tokenIn} → {tokenOut}
              </div>
              <p className="mt-1 text-sm">
                Swap on{" "}
                <span className="font-mono text-fg">
                  #{swapId}
                </span>{" "}
                {best.label}. Fill {fmtNum(best.amountOut, { compact: true })} {tokenOut} for{" "}
                {fmtNum(Number(amountIn) || 0, { compact: true })} {tokenIn}
                {best.kind === "hop" ? " · routed hop" : " · direct"}. Impact{" "}
                {fmtPct(best.priceImpact, 2, false)}, fee {best.feePct.toFixed(2)}%.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTickPool(swapId)}
              >
                Chart this book
              </Button>
              <Button variant="outline" size="sm" onClick={() => setTab("quotes")}>
                All routes
                <ArrowRight className="size-3.5" />
              </Button>
            </div>
          </div>
        </Card>
      )}

      <div className="flex gap-2 overflow-x-auto pb-1">
        {tick.books.map((b) => {
          const on = tickPoolId === b.pool.id;
          return (
            <button
              key={b.pool.id}
              type="button"
              onClick={() => setTickPool(b.pool.id)}
              className={cn(
                "flex h-11 shrink-0 items-center gap-2 rounded-md border px-3 text-xs",
                on
                  ? "border-accent/40 bg-accent/10 text-fg"
                  : "border-border text-muted-foreground hover:text-fg",
              )}
            >
              <PairMarks pair={b.pool.pair.symbol} />
              <span className="font-mono">
                {b.pool.pair.symbol} #{b.pool.id}
              </span>
              {b.bestBuy && <Badge variant="buy">Buy</Badge>}
              {b.bestSell && <Badge variant="sell">Sell</Badge>}
            </button>
          );
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-l-2 border-l-accent p-4">
          <div className="text-xs uppercase tracking-wider text-subtle">Last · 30s book</div>
          <div
            className={cn(
              "mt-1 font-mono text-2xl tabular-nums",
              tick.change >= 0 ? "text-buy" : "text-sell",
            )}
          >
            {fmtNum(tick.last, { digits: 4 })}
          </div>
          <div className="text-xs text-muted-foreground">{tick.unit}</div>
          <div className="mt-3 border-t border-border pt-2 font-mono text-xs text-subtle">
            {tick.pool
              ? `${fmtNum(tick.pool.pairPerLeef * 1e6, { digits: 3 })} ${tick.pool.pair.symbol} / 1M`
              : "—"}
            {usd ? ` · ${fmtUsd(usd, 8)} / LEEF` : ""}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase tracking-wider text-subtle">Backing</div>
          <div className="mt-1 font-mono text-lg tabular-nums">
            {tick.pool
              ? `${fmtNum(tick.pool.leef.quantity, { compact: true })} LEEF`
              : "—"}
          </div>
          <div className="text-xs text-muted-foreground">
            {tick.books.length} books ≥ {fmtNum(MIN_LEEF_BACKING, { compact: true })}
          </div>
          <div className="mt-3 border-t border-border pt-2 font-mono text-xs text-subtle">
            Range {fmtNum(tick.low, { digits: 4 })} – {fmtNum(tick.high, { digits: 4 })}
          </div>
        </Card>
        <Card
          className={cn(
            "p-4 border-l-2",
            tick.bestBuy
              ? "border-l-buy"
              : "border-l-border",
          )}
        >
          <div className="text-xs uppercase tracking-wider text-subtle">Best buy LEEF</div>
          <div className="mt-1 font-mono text-lg tabular-nums text-buy">
            {tick.bestBuy
              ? `#${tick.bestBuy.pool.id} ${tick.bestBuy.pool.pair.symbol}`
              : "—"}
          </div>
          <div className="text-xs text-muted-foreground">
            {tick.bestBuy?.buy
              ? `${fmtNum(tick.bestBuy.buy.amountOut, { compact: true })} LEEF · impact ${fmtPct(tick.bestBuy.buy.impact, 2, false)}`
              : "No fill"}
          </div>
          <div className="mt-3 border-t border-border pt-2 text-xs text-subtle">
            Least USD left on the table across backed books
          </div>
        </Card>
        <Card
          className={cn(
            "p-4 border-l-2",
            tick.bestSell ? "border-l-sell" : "border-l-border",
          )}
        >
          <div className="text-xs uppercase tracking-wider text-subtle">Best sell LEEF</div>
          <div className="mt-1 font-mono text-lg tabular-nums text-sell">
            {tick.bestSell
              ? `#${tick.bestSell.pool.id} ${tick.bestSell.pool.pair.symbol}`
              : "—"}
          </div>
          <div className="text-xs text-muted-foreground">
            {tick.bestSell?.sell
              ? `${fmtUsd(tick.bestSell.sell.usdOut, 4)} / 1M · impact ${fmtPct(tick.bestSell.sell.impact, 2, false)}`
              : "No fill"}
          </div>
          <div className="mt-3 border-t border-border pt-2 text-xs text-subtle">
            Highest USD back, hops included in Quotes
          </div>
        </Card>
      </div>

      <Card className="p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium">Pool loss · backed books</h3>
            <p className="text-xs text-muted-foreground">
              Buy = pair → LEEF at 10 WAX-equivalent. Sell = 1M LEEF marked in USD. 0% is the leader.
            </p>
          </div>
        </div>
        {tick.books.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No LEEF pool currently holds ≥ {fmtNum(MIN_LEEF_BACKING, { compact: true })} LEEF.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-subtle">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3 font-medium">Book</th>
                  <th className="py-2 pr-3 font-medium">LEEF</th>
                  <th className="py-2 pr-3 font-medium">USD / 1M</th>
                  <th className="py-2 pr-3 font-medium">Buy loss</th>
                  <th className="py-2 pr-3 font-medium">Sell loss</th>
                  <th className="py-2 font-medium">Fee</th>
                </tr>
              </thead>
              <tbody>
                {tick.books.map((b) => {
                  const on = tick.pool?.id === b.pool.id;
                  return (
                    <tr
                      key={b.pool.id}
                      onClick={() => setTickPool(b.pool.id)}
                      className={cn(
                        "cursor-pointer border-b border-border/70 hover:bg-surface-2",
                        on && "bg-accent/5",
                      )}
                    >
                      <td className="py-2.5 pr-3">
                        <span className="flex items-center gap-2">
                          <PairMarks pair={b.pool.pair.symbol} />
                          <span className="font-mono">
                            {b.pool.pair.symbol} #{b.pool.id}
                          </span>
                          {b.bestBuy && <Badge variant="buy">Buy</Badge>}
                          {b.bestSell && <Badge variant="sell">Sell</Badge>}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 font-mono tabular-nums">
                        {fmtNum(b.leefBacking, { compact: true })}
                      </td>
                      <td className="py-2.5 pr-3 font-mono tabular-nums">
                        {fmtNum(b.usdPerMillion, { digits: 4 })}
                      </td>
                      <td
                        className={cn(
                          "py-2.5 pr-3 font-mono tabular-nums",
                          b.bestBuy ? "text-buy" : "text-sell",
                        )}
                      >
                        {b.buy ? (b.bestBuy ? "least" : fmtPct(b.buy.loss, 1, false)) : "—"}
                      </td>
                      <td
                        className={cn(
                          "py-2.5 pr-3 font-mono tabular-nums",
                          b.bestSell ? "text-buy" : "text-sell",
                        )}
                      >
                        {b.sell ? (b.bestSell ? "least" : fmtPct(b.sell.loss, 1, false)) : "—"}
                      </td>
                      <td className="py-2.5 font-mono tabular-nums text-muted-foreground">
                        {b.pool.feePct.toFixed(2)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium">
              {tick.pool
                ? `LEEF / ${tick.pool.pair.symbol} · #${tick.pool.id}`
                : "No backed pool"}
            </h3>
            <p className="text-xs text-muted-foreground">
              {knobs.barSec}s bars from the 30s book pull · last close is the live Alcor print
            </p>
          </div>
          {last?.rsi != null && (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              RSI {last.rsi.toFixed(1)}
            </span>
          )}
        </div>
        {tick.candles.length < 8 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">Warming up the tick path…</p>
        ) : (
          <>
            <PriceChart points={tick.candles} engines={knobs.engines} unit={tick.unit} />
            {knobs.engines.macd && (
              <div className="mt-3 border-t border-border pt-3">
                <div className="mb-1 text-xs uppercase tracking-wider text-subtle">MACD</div>
                <MacdPane points={tick.candles} />
              </div>
            )}
            {knobs.engines.rsi && (
              <div className="mt-3 border-t border-border pt-3">
                <div className="mb-1 text-xs uppercase tracking-wider text-subtle">RSI</div>
                <RsiPane points={tick.candles} />
              </div>
            )}
          </>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="p-4 sm:p-5 lg:col-span-2">
          <h3 className="mb-1 text-sm font-medium">Signal engines</h3>
          <p className="mb-4 text-xs text-muted-foreground">
            Toggle which models vote. The blend is the average score, scaled by sensitivity.
          </p>
          <div className="flex flex-col gap-2">
            {INDICATORS.map((ind) => {
              const on = knobs.engines[ind.id];
              const reading = tick.signal.readings.find((r) => r.id === ind.id);
              return (
                <button
                  key={ind.id}
                  type="button"
                  onClick={() => toggleEngine(ind.id)}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left",
                    on
                      ? "border-accent/30 bg-accent/5"
                      : "border-border bg-bg text-muted-foreground",
                  )}
                >
                  <span>
                    <span className={cn("block text-sm", on ? "text-fg" : "text-muted-foreground")}>
                      {ind.label}
                    </span>
                    <span className="block text-xs text-subtle">{ind.hint}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    {on && reading ? (
                      <>
                        <span
                          className={cn(
                            "block font-mono text-xs tabular-nums",
                            reading.score > 0.12
                              ? "text-buy"
                              : reading.score < -0.12
                                ? "text-sell"
                                : "text-muted-foreground",
                          )}
                        >
                          {reading.label}
                        </span>
                        <span className="block font-mono text-xs text-subtle">
                          {reading.detail}
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-subtle">{on ? "Warming" : "Off"}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </Card>

        <Card className="p-4 sm:p-5 lg:col-span-3">
          <div className="mb-4 flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-accent" />
            <h3 className="text-sm font-medium">Customize ticker</h3>
          </div>
          <p className="mb-4 text-xs text-muted-foreground">
            Prints land on each 30s pool pull. History bars only seed the path until the next books arrive.
          </p>
          <div className="grid gap-5 sm:grid-cols-2">
            <Knob
              label="History"
              value={knobs.bars}
              min={60}
              max={260}
              step={10}
              format={(v) => `${v} bars`}
              onChange={(bars) => setTick({ bars })}
              ready={slidersOn}
            />
            <Knob
              label="Bar size"
              value={knobs.barSec}
              min={30}
              max={300}
              step={30}
              format={(v) => (v >= 60 ? `${v / 60}m` : `${v}s`)}
              onChange={(barSec) => setTick({ barSec })}
              ready={slidersOn}
            />
            <Knob
              label="Bollinger period"
              value={knobs.bbPeriod}
              min={8}
              max={40}
              step={1}
              onChange={(bbPeriod) => setTick({ bbPeriod })}
              muted={!knobs.engines.bb}
              ready={slidersOn}
            />
            <Knob
              label="Bollinger std"
              value={knobs.bbStd}
              min={1}
              max={3.2}
              step={0.1}
              format={(v) => v.toFixed(1) + "σ"}
              onChange={(bbStd) => setTick({ bbStd })}
              muted={!knobs.engines.bb}
              ready={slidersOn}
            />
            <Knob
              label="MACD fast"
              value={knobs.macdFast}
              min={5}
              max={20}
              step={1}
              onChange={(macdFast) => setTick({ macdFast })}
              muted={!knobs.engines.macd}
              ready={slidersOn}
            />
            <Knob
              label="MACD slow"
              value={knobs.macdSlow}
              min={12}
              max={40}
              step={1}
              onChange={(macdSlow) => setTick({ macdSlow })}
              muted={!knobs.engines.macd}
              ready={slidersOn}
            />
            <Knob
              label="MACD signal"
              value={knobs.macdSignal}
              min={4}
              max={16}
              step={1}
              onChange={(macdSignal) => setTick({ macdSignal })}
              muted={!knobs.engines.macd}
              ready={slidersOn}
            />
            <Knob
              label="RSI period"
              value={knobs.rsiPeriod}
              min={5}
              max={28}
              step={1}
              onChange={(rsiPeriod) => setTick({ rsiPeriod })}
              muted={!knobs.engines.rsi}
              ready={slidersOn}
            />
            <Knob
              label="EMA period"
              value={knobs.emaPeriod}
              min={5}
              max={55}
              step={1}
              onChange={(emaPeriod) => setTick({ emaPeriod })}
              muted={!knobs.engines.ema}
              ready={slidersOn}
            />
            <Knob
              label="SMA period"
              value={knobs.smaPeriod}
              min={5}
              max={80}
              step={1}
              onChange={(smaPeriod) => setTick({ smaPeriod })}
              muted={!knobs.engines.sma}
              ready={slidersOn}
            />
            <Knob
              label="Stochastic %K"
              value={knobs.stochK}
              min={5}
              max={21}
              step={1}
              onChange={(stochK) => setTick({ stochK })}
              muted={!knobs.engines.stoch}
              ready={slidersOn}
            />
            <Knob
              label="Stochastic %D"
              value={knobs.stochD}
              min={2}
              max={9}
              step={1}
              onChange={(stochD) => setTick({ stochD })}
              muted={!knobs.engines.stoch}
              ready={slidersOn}
            />
            <Knob
              label="AI sensitivity"
              value={knobs.sensitivity}
              min={0.4}
              max={2}
              step={0.05}
              format={(v) => v.toFixed(2) + "×"}
              onChange={(sensitivity) => setTick({ sensitivity })}
              ready={slidersOn}
            />
            <Knob
              label="Seed noise"
              value={knobs.vol}
              min={0.2}
              max={2.5}
              step={0.05}
              format={(v) => v.toFixed(2) + "×"}
              onChange={(vol) => setTick({ vol })}
              ready={slidersOn}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}

function Knob({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  muted,
  ready,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  muted?: boolean;
  ready: boolean;
}) {
  const safe = Number.isFinite(value) ? value : min;
  return (
    <label className={cn("block", muted && "opacity-40")}>
      <span className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums text-fg">
          {format ? format(safe) : String(safe)}
        </span>
      </span>
      {ready ? (
        <Slider
          min={min}
          max={max}
          step={step}
          value={[safe]}
          onValueChange={([v]) => {
            if (typeof v !== "number") return;
            const n = Number((Math.round(v / step) * step).toFixed(4));
            onChange(n);
          }}
          disabled={muted}
          aria-label={label}
        />
      ) : (
        <div className="relative flex h-11 w-full items-center" aria-hidden>
          <div className="h-1.5 w-full rounded-full bg-surface-3" />
        </div>
      )}
    </label>
  );
}
