import {
  BrainCircuit,
  CirclePlay,
  CircleStop,
  Crosshair,
  RotateCcw,
  ShieldAlert,
  Waves,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  BOT_WARMUP_POINTS,
  evaluateBot,
  STRATEGIES,
  type BotStrategy,
} from "@/lib/leef/bot-engine";
import { fmtNum, fmtUsd } from "@/lib/leef/format";
import type { LeefSnapshot } from "@/lib/leef/types";
import { hasSecret } from "@/lib/wallet/secret";
import { cn } from "@/lib/utils";
import { useBot, type BotDecisionLog } from "@/store/bot";
import { useWallet } from "@/store/wallet";
import { runBotOnce } from "./use-bot-loop";

const KIND_VARIANT: Record<
  BotDecisionLog["kind"],
  "leef" | "accent" | "wax" | "plain" | "warn" | "sell"
> = {
  buy: "leef",
  sell: "accent",
  arb: "wax",
  hold: "plain",
  skip: "plain",
  stop: "warn",
  error: "sell",
};

export function BotDesk({ snap }: { snap: LeefSnapshot }) {
  const b = useBot();
  const mode = useWallet((s) => s.mode);
  const account = useWallet((s) => s.account);
  const setImportOpen = useWallet((s) => s.setImportOpen);
  const paperBalances = useWallet((s) => s.paperBalances);
  const liveBalances = useWallet((s) => s.liveBalances);
  const balances = mode === "live" ? liveBalances : paperBalances;
  const [confirmLive, setConfirmLive] = useState(false);
  const [confirmForce, setConfirmForce] = useState<"buy" | "sell" | null>(null);
  const [busyForce, setBusyForce] = useState(false);

  const liveReady = mode === "live" && hasSecret();
  const liveBook = snap.source === "live";
  const coolLeft = Math.max(0, Math.ceil((b.cooldownUntil - Date.now()) / 1000));
  const warmup = Math.min(b.series.length, BOT_WARMUP_POINTS);

  const equityUsd =
    (balances.WAX ?? 0) * snap.waxUsd + (balances.LEEF ?? 0) * snap.leefUsd;
  const winRate = b.stats.trades > 0 ? b.stats.wins / b.stats.trades : 0;

  /** Dry-run: what the bot would do on this book right now. */
  const preview = evaluateBot({
    now: Date.now(),
    snap,
    series: b.series,
    running: true,
    strategy: b.strategy,
    goals: b.goals,
    risk: b.risk,
    position: b.position,
    gridAnchor: b.gridAnchor,
    balances,
    cooldownUntil: b.cooldownUntil,
    tradesThisHour: b.tradesThisHour,
    sessionRealizedUsd: b.stats.realizedUsd,
    sessionStartEquityUsd: b.stats.startEquityUsd,
  });

  function onStart() {
    if (liveReady && !confirmLive) {
      setConfirmLive(true);
      return;
    }
    setConfirmLive(false);
    b.start(equityUsd);
    void runBotOnce(snap);
  }

  function onForce(kind: "buy" | "sell") {
    if (liveReady && confirmForce !== kind) {
      setConfirmForce(kind);
      return;
    }
    setConfirmForce(null);
    setBusyForce(true);
    void runBotOnce(snap, { force: kind }).finally(() => setBusyForce(false));
  }

  const strat = STRATEGIES.find((s) => s.id === b.strategy)!;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-base font-medium tracking-tight">AI trading bot</h2>
          <p className="text-xs text-muted-foreground">
            Import a key, pick a strategy, set your goals, hit start. Every 30s
            book pull the engines vote, guards check risk, and the bot clips —
            paper by default, live when a session key is in this tab.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={b.running ? (liveReady ? "leef" : "accent") : "plain"}>
            {b.running ? (liveReady ? "Live · running" : "Paper · running") : "Stopped"}
          </Badge>
          <Badge variant="plain">
            {b.stats.trades} trades · {b.tradesThisHour}/{b.risk.maxTradesHour} this hour
          </Badge>
          <Badge variant={b.stats.realizedUsd >= 0 ? "leef" : "sell"}>
            {b.stats.realizedUsd >= 0 ? "+" : ""}
            {fmtUsd(b.stats.realizedUsd, 2)} session
          </Badge>
        </div>
      </div>

      {b.running && liveReady && (
        <div className="flex items-start gap-2 rounded-lg border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          Live bot is spending real tokens from {account} via swap.alcor on the
          WAX blockchain. Stops and goals are on; you can stop anytime.
        </div>
      )}
      {!liveBook && (
        <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          The Alcor book is stale — the bot holds until live data returns.
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-5">
        {/* ------------------------------ left rail ------------------------------ */}
        <div className="flex flex-col gap-5 lg:col-span-2">
          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium">Engine</h3>
                <p className="text-xs text-muted-foreground">{b.lastReason}</p>
              </div>
              <span className="relative flex size-2.5">
                <span
                  className={cn(
                    "absolute inline-flex h-full w-full rounded-full opacity-70",
                    b.running && "animate-ping bg-leef",
                  )}
                />
                <span
                  className={cn(
                    "relative inline-flex size-2.5 rounded-full",
                    b.running ? "bg-leef" : "bg-surface-3",
                  )}
                />
              </span>
            </div>

            {b.running ? (
              <Button variant="danger" className="h-12 w-full text-base" onClick={() => b.stop()}>
                <CircleStop className="size-4" />
                Stop the bot
              </Button>
            ) : (
              <Button
                variant="leef"
                className="h-12 w-full text-base"
                onClick={onStart}
                disabled={!liveBook}
              >
                <CirclePlay className="size-4" />
                {confirmLive
                  ? "Real funds will trade — click again to start LIVE"
                  : `Start ${liveReady ? "live" : "paper"} bot`}
              </Button>
            )}
            {confirmLive && !b.running && (
              <p className="mt-2 text-xs text-sell">
                Live mode broadcasts real swaps from {account}. Goals and stops
                stay enforced. This cannot be undone per-trade.
              </p>
            )}
            {!liveReady && (
              <Button
                variant="outline"
                className="mt-2 w-full"
                onClick={() => setImportOpen(true)}
              >
                Import key for live trading
              </Button>
            )}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-subtle">
              <span>
                {warmup}/{BOT_WARMUP_POINTS} prints for the engines
              </span>
              {coolLeft > 0 && <span>Next trade in {coolLeft}s</span>}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${(warmup / BOT_WARMUP_POINTS) * 100}%` }}
              />
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busyForce || !liveBook}
                onClick={() => onForce("buy")}
              >
                {confirmForce === "buy" ? "Confirm live buy" : "Buy a clip now"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busyForce || !b.position}
                onClick={() => onForce("sell")}
              >
                {confirmForce === "sell" ? "Confirm live sell" : "Sell position now"}
              </Button>
            </div>
          </Card>

          <Card className="p-5">
            <h3 className="mb-1 flex items-center gap-2 text-sm font-medium">
              <BrainCircuit className="size-4 text-accent" />
              Strategy
            </h3>
            <p className="mb-3 text-xs text-muted-foreground">
              {strat.detail}
            </p>
            <div className="flex flex-col gap-2">
              {STRATEGIES.map((s) => {
                const on = s.id === b.strategy;
                return (
                  <button
                    key={s.id}
                    type="button"
                    disabled={b.running}
                    onClick={() => b.setStrategy(s.id)}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                      on
                        ? "border-accent/40 bg-accent/10"
                        : "border-border bg-background text-muted-foreground hover:text-foreground",
                      b.running && "opacity-60",
                    )}
                  >
                    <span>
                      <span className={cn("block text-sm", on && "text-foreground")}>
                        {s.name}
                      </span>
                      <span className="block text-xs text-subtle">{s.tagline}</span>
                    </span>
                    <Badge variant={on ? "accent" : "plain"}>{s.bestFor}</Badge>
                  </button>
                );
              })}
            </div>
          </Card>

          <GoalsCard />
          <RiskCard strategy={b.strategy} />
        </div>

        {/* ------------------------------ right rail ------------------------------ */}
        <div className="flex flex-col gap-5 lg:col-span-3">
          <Card className="border-accent/30 bg-accent/5 p-4 sm:p-5">
            <div className="text-xs font-medium uppercase tracking-wider text-accent">
              Next evaluation · {strat.name}
            </div>
            <p className="mt-1 text-sm">
              {preview.kind === "buy" && (
                <>
                  <Crosshair className="mr-1 inline size-3.5 text-leef" />
                  Would buy with {fmtNum(preview.amountWax)} WAX on {preview.route.label} ·{" "}
                  {fmtNum(preview.route.amountOut, { compact: true })} LEEF · impact{" "}
                  {(preview.route.priceImpact * 100).toFixed(2)}%
                </>
              )}
              {preview.kind === "sell" && (
                <>
                  <Crosshair className="mr-1 inline size-3.5 text-sell" />
                  Would sell {fmtNum(preview.amountLeef, { compact: true })} LEEF on{" "}
                  {preview.route.label} · {fmtNum(preview.route.amountOut, { digits: 2 })} WAX
                </>
              )}
              {preview.kind === "arb" && (
                <>
                  <Crosshair className="mr-1 inline size-3.5 text-wax" />
                  Would arb #{preview.plan.buyPool.id} → #{preview.plan.sellPool.id} ·{" "}
                  {fmtNum(preview.plan.waxIn)} WAX in, est {fmtNum(preview.plan.waxOut, { digits: 3 })} out
                </>
              )}
              {(preview.kind === "hold" || preview.kind === "stop") && (
                <span className="text-muted-foreground">{preview.reason}</span>
              )}
            </p>
            <p className="mt-1 text-xs text-subtle">{preview.reason}</p>
          </Card>

          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="border-l-2 border-l-leef p-4">
              <div className="text-xs uppercase tracking-wider text-subtle">Position</div>
              {b.position ? (
                <>
                  <div className="mt-1 font-mono text-lg tabular-nums text-leef">
                    {fmtNum(b.position.amountLeef, { compact: true })} LEEF
                  </div>
                  <PositionPnl snap={snap} />
                </>
              ) : (
                <>
                  <div className="mt-1 font-mono text-lg tabular-nums">Flat</div>
                  <div className="text-xs text-muted-foreground">No open position</div>
                </>
              )}
            </Card>
            <Card className="p-4">
              <div className="text-xs uppercase tracking-wider text-subtle">Session P&L</div>
              <div
                className={cn(
                  "mt-1 font-mono text-lg tabular-nums",
                  b.stats.realizedUsd >= 0 ? "text-buy" : "text-sell",
                )}
              >
                {b.stats.realizedUsd >= 0 ? "+" : ""}
                {fmtUsd(b.stats.realizedUsd, 2)}
              </div>
              <div className="text-xs text-muted-foreground">
                win rate {(winRate * 100).toFixed(0)}% · {b.stats.trades} trades
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-xs uppercase tracking-wider text-subtle">Equity</div>
              <div className="mt-1 font-mono text-lg tabular-nums">{fmtUsd(equityUsd, 2)}</div>
              <div className="text-xs text-muted-foreground">
                start {fmtUsd(b.stats.startEquityUsd, 2)}
              </div>
            </Card>
          </div>

          {b.stats.equity.length > 1 && (
            <Card className="p-4 sm:p-5">
              <h3 className="mb-3 text-sm font-medium">Session equity</h3>
              <div className="h-28">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={b.stats.equity} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-leef)" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="var(--color-leef)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <YAxis
                      domain={["auto", "auto"]}
                      hide
                    />
                    <Area
                      type="monotone"
                      dataKey="usd"
                      stroke="var(--color-leef)"
                      fill="url(#eqFill)"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}

          <Card className="p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">Decision log</h3>
                <p className="text-xs text-muted-foreground">
                  What the engines saw and did on each 30s pull.
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => b.resetSession(equityUsd)}
              >
                <RotateCcw className="size-3.5" />
                Reset session
              </Button>
            </div>
            {b.decisions.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Nothing yet — start the bot and the reasoning shows up here.
              </p>
            ) : (
              <div className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
                {b.decisions.map((d) => (
                  <div
                    key={d.id}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-muted-foreground">
                        {new Date(d.t).toISOString().slice(11, 19)} UTC
                      </span>
                      <span className="flex items-center gap-2">
                        {d.pnlUsd != null && (
                          <span
                            className={cn(
                              "font-mono tabular-nums",
                              d.pnlUsd >= 0 ? "text-buy" : "text-sell",
                            )}
                          >
                            {d.pnlUsd >= 0 ? "+" : ""}
                            {fmtUsd(d.pnlUsd, 2)}
                          </span>
                        )}
                        <Badge variant={KIND_VARIANT[d.kind]}>
                          {d.mode} · {d.kind}
                        </Badge>
                      </span>
                    </div>
                    <div className="mt-1 text-muted-foreground">{d.reason}</div>
                    {d.txid && (
                      <a
                        className="mt-0.5 block font-mono text-accent hover:underline"
                        href={`https://waxblock.io/transaction/${d.txid}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        tx {d.txid.slice(0, 14)}…
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function PositionPnl({ snap }: { snap: LeefSnapshot }) {
  const position = useBot((s) => s.position);
  if (!position) return null;
  const pnlPct = (snap.leefUsd / position.entryUsd - 1) * 100;
  const valueUsd = position.amountLeef * snap.leefUsd;
  const pnlUsd = valueUsd - position.entryCostUsd;
  const heldMin = Math.max(0, Math.round((Date.now() - position.since) / 60_000));
  return (
    <>
      <div
        className={cn(
          "font-mono text-xs tabular-nums",
          pnlPct >= 0 ? "text-buy" : "text-sell",
        )}
      >
        {pnlPct >= 0 ? "+" : ""}
        {pnlPct.toFixed(2)}% · {pnlUsd >= 0 ? "+" : ""}
        {fmtUsd(pnlUsd, 2)}
      </div>
      <div className="mt-3 border-t border-border pt-2 font-mono text-xs text-subtle">
        entry ${(position.entryUsd * 1e6).toFixed(4)}/1M · {heldMin}m · {position.mode}
      </div>
    </>
  );
}

function GoalsCard() {
  const goals = useBot((s) => s.goals);
  const setGoals = useBot((s) => s.setGoals);
  return (
    <Card className="p-5">
      <h3 className="mb-1 text-sm font-medium">Goals &amp; guards</h3>
      <p className="mb-4 text-xs text-muted-foreground">
        Enforced on every position, any strategy. 0 disables the session guards.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <NumField
          label="Take-profit"
          suffix="%"
          value={goals.takeProfitPct}
          min={0}
          max={100}
          step={0.5}
          onChange={(takeProfitPct) => setGoals({ takeProfitPct })}
        />
        <NumField
          label="Stop-loss"
          suffix="%"
          value={goals.stopLossPct}
          min={0}
          max={100}
          step={0.5}
          onChange={(stopLossPct) => setGoals({ stopLossPct })}
        />
        <NumField
          label="Trailing stop"
          suffix="%"
          value={goals.trailingPct}
          min={0}
          max={50}
          step={0.5}
          onChange={(trailingPct) => setGoals({ trailingPct })}
        />
        <NumField
          label="Session goal"
          suffix="$"
          value={goals.sessionGoalUsd}
          min={0}
          max={10000}
          step={1}
          onChange={(sessionGoalUsd) => setGoals({ sessionGoalUsd })}
        />
        <NumField
          label="Max drawdown"
          suffix="%"
          value={goals.maxDrawdownPct}
          min={0}
          max={90}
          step={1}
          onChange={(maxDrawdownPct) => setGoals({ maxDrawdownPct })}
        />
      </div>
    </Card>
  );
}

function RiskCard({ strategy }: { strategy: BotStrategy }) {
  const risk = useBot((s) => s.risk);
  const setRisk = useBot((s) => s.setRisk);
  const [slidersOn, setSlidersOn] = useState(false);
  useEffect(() => setSlidersOn(true), []);
  return (
    <Card className="p-5">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-medium">
        <Waves className="size-4 text-accent" />
        Risk &amp; sizing
      </h3>
      <p className="mb-4 text-xs text-muted-foreground">
        Per-clip size and the hard guardrails every strategy obeys.
      </p>
      <div className="space-y-3">
        <Knob
          ready={slidersOn}
          label="Clip size"
          value={risk.clipWax}
          min={1}
          max={250}
          step={1}
          format={(v) => `${v} WAX`}
          onChange={(clipWax) => setRisk({ clipWax })}
        />
        <Knob
          ready={slidersOn}
          label="Max position"
          value={risk.maxPositionWax}
          min={10}
          max={1000}
          step={10}
          format={(v) => `${v} WAX`}
          onChange={(maxPositionWax) => setRisk({ maxPositionWax })}
        />
        <Knob
          ready={slidersOn}
          label="Max price impact"
          value={risk.maxImpactPct}
          min={0.2}
          max={8}
          step={0.1}
          format={(v) => `${v.toFixed(1)}%`}
          onChange={(maxImpactPct) => setRisk({ maxImpactPct })}
        />
        <Knob
          ready={slidersOn}
          label="Cooldown"
          value={risk.cooldownSec}
          min={30}
          max={600}
          step={15}
          format={(v) => `${v}s`}
          onChange={(cooldownSec) => setRisk({ cooldownSec })}
        />
        <Knob
          ready={slidersOn}
          label="Trades / hour"
          value={risk.maxTradesHour}
          min={1}
          max={30}
          step={1}
          format={(v) => String(v)}
          onChange={(maxTradesHour) => setRisk({ maxTradesHour })}
        />
        <Knob
          ready={slidersOn}
          label="Slippage guard"
          value={risk.slippage}
          min={0.1}
          max={3}
          step={0.1}
          format={(v) => `${v.toFixed(1)}%`}
          onChange={(slippage) => setRisk({ slippage })}
        />
        {strategy === "signal" && (
          <Knob
            ready={slidersOn}
            label="Min engine confidence"
            value={risk.minConfidence}
            min={20}
            max={90}
            step={1}
            format={(v) => `${v}%`}
            onChange={(minConfidence) => setRisk({ minConfidence })}
          />
        )}
        {strategy === "spread" && (
          <Knob
            ready={slidersOn}
            label="Min arb profit"
            value={risk.minEdgePct}
            min={0.3}
            max={10}
            step={0.1}
            format={(v) => `${v.toFixed(1)}%`}
            onChange={(minEdgePct) => setRisk({ minEdgePct })}
          />
        )}
        {strategy === "grid" && (
          <Knob
            ready={slidersOn}
            label="Grid step"
            value={risk.gridStepPct}
            min={0.5}
            max={15}
            step={0.25}
            format={(v) => `${v.toFixed(2)}%`}
            onChange={(gridStepPct) => setRisk({ gridStepPct })}
          />
        )}
      </div>
    </Card>
  );
}

function NumField({
  label,
  suffix,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  suffix: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1 rounded-md border border-border bg-background px-2">
        <Input
          type="number"
          inputMode="decimal"
          className="h-9 border-0 bg-transparent px-0 font-mono text-sm"
          value={String(value)}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
          }}
        />
        <span className="text-xs text-subtle">{suffix}</span>
      </span>
    </label>
  );
}

function Knob({
  ready,
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  ready: boolean;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums text-foreground">{format(value)}</span>
      </span>
      {ready ? (
        <Slider
          min={min}
          max={max}
          step={step}
          value={[value]}
          onValueChange={([v]) => {
            if (typeof v !== "number") return;
            const n = Number((Math.round(v / step) * step).toFixed(4));
            onChange(n);
          }}
          aria-label={label}
        />
      ) : (
        <div className="h-9" />
      )}
    </label>
  );
}
