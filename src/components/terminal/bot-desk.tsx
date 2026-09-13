import {
  BrainCircuit,
  CirclePlay,
  CircleStop,
  Crosshair,
  RotateCcw,
  ScanSearch,
  ShieldAlert,
  Waves,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Area, AreaChart, YAxis } from "recharts";
import { ChartFrame } from "./chart-frame";
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
import { positionMarkUsd } from "@/lib/leef/risk-usd";
import { fmtNum, fmtUsd } from "@/lib/leef/format";
import type { LeefSnapshot } from "@/lib/leef/types";
import { hasSecret } from "@/lib/wallet/secret";
import { hasWalletSession } from "@/lib/wallet/session";
import { cn } from "@/lib/utils";
import { useBot, type BotDecisionLog } from "@/store/bot";
import { clampSyncSec, DEFAULT_SYNC_SEC, useTerminal } from "@/store/terminal";
import { useWallet } from "@/store/wallet";
import { balanceForIdentifier, markPortfolioUsd } from "@/lib/wallet/balances";
import {
  FOCUS_PRESETS,
  listBaseTokens,
  listQuoteTokens,
  suggestBotSettings,
  suggestPair,
  type AdvisorSuggestion,
} from "@/lib/leef/advisor";
import { runBotOnce } from "./use-bot-loop";
import { snapshotTargets, type GrowthMode } from "@/lib/leef/growth-engine";
import { listBaseTokens as listTreasureTokens } from "@/lib/leef/advisor";

const KIND_VARIANT: Record<
  BotDecisionLog["kind"],
  "leef" | "accent" | "wax" | "plain" | "warn" | "sell"
> = {
  buy: "leef",
  sell: "accent",
  arb: "wax",
  swap: "accent",
  hold: "plain",
  skip: "plain",
  stop: "warn",
  error: "sell",
};

export function BotDesk({ snap }: { snap: LeefSnapshot }) {
  const b = useBot();
  const mode = useWallet((s) => s.mode);
  const account = useWallet((s) => s.account);
  const authType = useWallet((s) => s.authType);
  const setImportOpen = useWallet((s) => s.setImportOpen);
  const paperBalances = useWallet((s) => s.paperBalances);
  const liveBalances = useWallet((s) => s.liveBalances);
  const balances = mode === "live" ? liveBalances : paperBalances;
  const [confirmLive, setConfirmLive] = useState(false);
  const [confirmForce, setConfirmForce] = useState<"buy" | "sell" | null>(null);
  const [busyForce, setBusyForce] = useState(false);

  const liveReady = mode === "live" && (hasSecret() || hasWalletSession());
  const liveBook = snap.source === "live";
  const coolLeft = Math.max(0, Math.ceil((b.cooldownUntil - Date.now()) / 1000));
  const warmup = Math.min(b.series.length, BOT_WARMUP_POINTS);

  const equityUsd = markPortfolioUsd(snap, balances).totalUsd;
  const winRate = b.stats.trades > 0 ? b.stats.wins / b.stats.trades : 0;

  const syncSec = useTerminal((s) => clampSyncSec(s.syncSec ?? DEFAULT_SYNC_SEC));
  /** Dry-run: what the bot would do on this book right now. */
  const preview = evaluateBot({
    now: Date.now(),
    snap,
    series: b.series,
    running: true,
    strategy: b.strategy,
    goals: b.goals,
    risk: { ...b.risk, maxQuoteAgeSec: Math.max(b.risk.maxQuoteAgeSec, syncSec + 15) },
    position: b.position,
    gridAnchor: b.gridAnchor,
    balances,
    cooldownUntil: b.cooldownUntil,
    tradesThisHour: b.tradesThisHour,
    sessionRealizedUsd: b.stats.realizedUsd,
    sessionStartEquityUsd: b.stats.startEquityUsd,
    quote: b.quote,
    base: b.base,
    growthTargets: b.growthTargets,
    growthMode: b.growthMode,
  });

  function onStart() {
    if (liveReady && !confirmLive) {
      setConfirmLive(true);
      return;
    }
    setConfirmLive(false);
    const start: Record<string, number> = {};
    for (const t of snapshotTargets(snap, balances, b.growthTargets)) start[t.symbol] = t.amount;
    b.snapshotGrowthStart(start);
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
            Connect a wallet, pick a pair, set goals, hit start. The live Alcor
            book drives every clip — no simulated LEEF bag. Unsigned mode
            quotes only; live fills need a session key or wallet prompt.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={b.running ? (liveReady ? "leef" : "accent") : "plain"}>
            {b.running ? (liveReady ? "Live · running" : "Unsigned · running") : "Stopped"}
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
          WAX blockchain.{" "}
          {authType === "key"
            ? "The in-tab key signs automatically."
            : "Your wallet will ask you to sign each trade (Cloud Wallet can whitelist it)."}
          {" "}Stops and goals are on; you can stop anytime.
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
        <div className="flex min-w-0 flex-col gap-5 lg:col-span-2">
          <Card className="p-4 sm:p-5">
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
                  : `Start ${liveReady ? "live" : "unsigned"} bot`}
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
                Connect wallet for live trading
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

          <Card className="p-4 sm:p-5">
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
                    <span className="hidden min-[420px]:inline-flex">
                      <Badge variant={on ? "accent" : "plain"}>{s.bestFor}</Badge>
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          {b.strategy !== "unleashed" && <GoalsCard />}
          {b.strategy !== "unleashed" && b.strategy !== "growth" && <AdvisorCard snap={snap} />}
          {b.strategy === "growth" && <TreasureCard snap={snap} />}
          <RiskCard strategy={b.strategy} snap={snap} />
        </div>

        {/* ------------------------------ right rail ------------------------------ */}
        <div className="flex min-w-0 flex-col gap-5 lg:col-span-3">
          <Card className="border-accent/30 bg-accent/5 p-4 sm:p-5">
            <div className="text-xs font-medium uppercase tracking-wider text-accent">
              Next evaluation · {strat.name}
            </div>
            <p className="mt-1 text-sm">
              {preview.kind === "buy" && (
                <>
                  <Crosshair className="mr-1 inline size-3.5 text-leef" />
                  Would buy with {fmtNum(preview.amountWax)} {b.quote} on {preview.route.label} ·{" "}
                  {fmtNum(preview.route.amountOut, { compact: true })} {b.base} · impact{" "}
                  {(preview.route.priceImpact * 100).toFixed(2)}%
                </>
              )}
              {preview.kind === "sell" && (
                <>
                  <Crosshair className="mr-1 inline size-3.5 text-sell" />
                  Would sell {fmtNum(preview.amountLeef, { compact: true })} {b.base} on{" "}
                  {preview.route.label} ·                   {fmtNum(preview.route.amountOut, { digits: 2 })} {b.quote}
                </>
              )}
              {preview.kind === "arb" && (
                <>
                  <Crosshair className="mr-1 inline size-3.5 text-wax" />
                  Would arb #{preview.plan.buyPool.id} → #{preview.plan.sellPool.id} ·{" "}
                  {fmtNum(preview.plan.waxIn)} WAX in, est {fmtNum(preview.plan.waxOut, { digits: 3 })} out
                </>
              )}
              {preview.kind === "swap" && (
                <>
                  <Crosshair className="mr-1 inline size-3.5 text-accent" />
                  Would swap {fmtNum(preview.amountIn, { compact: true })} {preview.tokenIn} →{" "}
                  {preview.tokenOut} on {preview.route.label}
                </>
              )}
              {(preview.kind === "hold" || preview.kind === "stop") && (
                <span className="text-muted-foreground">{preview.reason}</span>
              )}
            </p>
            <p className="mt-1 text-xs text-subtle">{preview.reason}</p>
          </Card>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
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
              <div className="text-xs uppercase tracking-wider text-subtle">
                {b.strategy === "volume" ? "Volume made" : "Equity"}
              </div>
              {b.strategy === "volume" ? (
                <>
                  <div className="mt-1 font-mono text-lg tabular-nums text-wax">
                    {fmtUsd(b.stats.volumeUsd, 2)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    echo cost {fmtUsd(b.stats.echoCostUsd, 2)} · equity {fmtUsd(equityUsd, 2)}
                  </div>
                </>
              ) : (
                <>
                  <div className="mt-1 font-mono text-lg tabular-nums">{fmtUsd(equityUsd, 2)}</div>
                  <div className="text-xs text-muted-foreground">
                    start {fmtUsd(b.stats.startEquityUsd, 2)}
                  </div>
                </>
              )}
            </Card>
          </div>

          {b.stats.equity.length > 1 && (
            <Card className="p-4 sm:p-5">
              <h3 className="mb-3 text-sm font-medium">Session equity</h3>
              <ChartFrame className="h-28">
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
              </ChartFrame>
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

function AdvisorCard({ snap }: { snap: LeefSnapshot }) {
  const base = useBot((s) => s.base);
  const setBase = useBot((s) => s.setBase);
  const quote = useBot((s) => s.quote);
  const setQuote = useBot((s) => s.setQuote);
  const focus = useBot((s) => s.focus);
  const setFocus = useBot((s) => s.setFocus);
  const strategy = useBot((s) => s.strategy);
  const setRisk = useBot((s) => s.setRisk);
  const running = useBot((s) => s.running);
  const balances = useWallet((s) => s.balances());
  const cpuPct = useWallet((s) => s.cpuPct);
  const netPct = useWallet((s) => s.netPct);
  const ramPct = useWallet((s) => s.ramPct);
  const [scan, setScan] = useState<AdvisorSuggestion | null>(null);

  const bases = listBaseTokens(snap);
  const quotes = listQuoteTokens(snap, base);
  const focusChoices = [...new Set([...FOCUS_PRESETS, ...quotes, ...bases])];

  function runScan() {
    const pair = suggestPair(snap, balances, focus);
    setBase(pair.base);
    setQuote(pair.quote);
    setScan(
      suggestBotSettings({
        snap,
        balances,
        base: pair.base,
        quote: pair.quote,
        focus,
        strategy,
        cpuPct,
        netPct,
        ramPct,
      }),
    );
  }

  function applyScan() {
    if (!scan) return;
    setBase(scan.base);
    setQuote(scan.quote);
    setRisk(scan.risk);
    setScan(null);
  }

  function toggleFocus(sym: string) {
    if (focus.includes(sym)) setFocus(focus.filter((x) => x !== sym));
    else setFocus([...focus, sym]);
    setScan(null);
  }

  return (
    <Card className="p-4 sm:p-5">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-medium">
        <ScanSearch className="size-4 text-accent" />
        Pair & wallet scan
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Not only LEEF/WAX — LEEF/USDC, LEEF/PARAUSD, WAX/USDC hops, whatever
        books exist. Scan sizes from this wallet and CPU/NET/RAM. You apply.
      </p>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <TokenSearch
          label="Base (not WAX)"
          value={base}
          options={bases}
          disabled={running}
          onChange={(v) => {
            setBase(v);
            setScan(null);
          }}
        />
        <TokenSearch
          label="Quote (not LEEF)"
          value={quote}
          options={quotes}
          disabled={running}
          onChange={(v) => {
            setQuote(v);
            setScan(null);
          }}
        />
      </div>
      <p className="mb-1 text-xs text-muted-foreground">Focus tokens (scan bias)</p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {focusChoices.slice(0, 12).map((sym) => {
          const on = focus.includes(sym);
          return (
            <button
              key={sym}
              type="button"
              disabled={running}
              onClick={() => toggleFocus(sym)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs",
                on ? "border-accent/50 bg-accent/15 text-foreground" : "border-border text-muted-foreground",
              )}
            >
              {sym}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={runScan} disabled={running}>
          Scan wallet & market
        </Button>
        {scan && (
          <Button type="button" variant="leef" size="sm" onClick={applyScan} disabled={running}>
            Apply {scan.base}/{scan.quote} + sizes
          </Button>
        )}
      </div>
      {scan && (
        <div className="mt-3 space-y-1.5 text-xs">
          {scan.why.map((w) => (
            <p key={w.label}>
              <span className="text-muted-foreground">{w.label}: </span>
              {w.detail}
            </p>
          ))}
          <p className="text-subtle">
            Suggested cooldown {scan.risk.cooldownSec}s · {scan.risk.maxTradesHour}/hour · impact{" "}
            {scan.risk.maxImpactPct}%
          </p>
          {scan.warnings.map((w) => (
            <p key={w} className="text-warn">
              {w}
            </p>
          ))}
        </div>
      )}
    </Card>
  );
}

function GoalsCard() {
  const goals = useBot((s) => s.goals);
  const setGoals = useBot((s) => s.setGoals);
  return (
    <Card className="p-4 sm:p-5">
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

function TreasureCard({ snap }: { snap: LeefSnapshot }) {
  const targets = useBot((s) => s.growthTargets);
  const mode = useBot((s) => s.growthMode);
  const start = useBot((s) => s.growthStart);
  const setTargets = useBot((s) => s.setGrowthTargets);
  const setMode = useBot((s) => s.setGrowthMode);
  const running = useBot((s) => s.running);
  const balances = useWallet((s) => s.balances());
  const now = snapshotTargets(snap, balances, targets);
  const choices = listTreasureTokens(snap);
  if (!choices.includes("WAX")) choices.unshift("WAX");

  function setSlot(i: number, symbol: string) {
    const next = targets.map((t, j) => (j === i ? { ...t, symbol } : t));
    setTargets(next);
  }
  function setWeight(i: number, weight: number) {
    const next = targets.map((t, j) => (j === i ? { ...t, weight } : t));
    setTargets(next);
  }
  function addSlot() {
    if (targets.length >= 3) return;
    const used = new Set(targets.map((t) => t.symbol));
    const extra = choices.find((c) => !used.has(c)) ?? "LEEF";
    setTargets([...targets, { symbol: extra, weight: 10 }]);
  }
  function removeSlot(i: number) {
    if (targets.length <= 1) return;
    setTargets(targets.filter((_, j) => j !== i));
  }

  const modes: { id: GrowthMode; label: string; hint: string }[] = [
    { id: "max", label: "Max", hint: "Aggressive" },
    { id: "balanced", label: "Balanced", hint: "Recommended" },
    { id: "compound", label: "Compound", hint: "Small edges" },
  ];

  return (
    <Card className="p-4 sm:p-5">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-medium">
        <BrainCircuit className="size-4 text-leef" />
        Treasure
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Name 1–3 assets to grow. The bot maximizes those token counts without
        destroying portfolio value. HOLD when nothing is strong enough — and
        it will say why.
      </p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            disabled={running}
            onClick={() => setMode(m.id)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs",
              mode === m.id
                ? "border-accent/50 bg-accent/15 text-foreground"
                : "border-border text-muted-foreground",
            )}
          >
            {m.label}
            <span className="ml-1 text-subtle">{m.hint}</span>
          </button>
        ))}
      </div>
      <div className="space-y-2">
        {targets.map((t, i) => {
          const live = now.find((n) => n.symbol === t.symbol);
          const opened = start[t.symbol];
          const delta = live && opened != null ? live.amount - opened : null;
          return (
            <div key={`${t.symbol}-${i}`} className="rounded-md border border-border p-2">
              <div className="flex items-center gap-2">
                <select
                  className="h-8 flex-1 rounded-md border border-border bg-background px-2 font-mono text-xs"
                  value={t.symbol}
                  disabled={running}
                  onChange={(e) => setSlot(i, e.target.value)}
                >
                  {choices.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <Input
                  type="number"
                  className="h-8 w-16 font-mono text-xs"
                  value={Math.round(t.weight)}
                  min={1}
                  max={100}
                  disabled={running}
                  onChange={(e) => setWeight(i, Number(e.target.value) || 0)}
                />
                <span className="text-xs text-subtle">%</span>
                {targets.length > 1 && (
                  <button
                    type="button"
                    disabled={running}
                    className="text-xs text-muted-foreground hover:text-sell"
                    onClick={() => removeSlot(i)}
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="mt-1 font-mono text-xs text-muted-foreground">
                {live ? `${fmtNum(live.amount, { compact: true })} · ${fmtUsd(live.usd)}` : "—"}
                {delta != null && (
                  <span className={delta >= 0 ? " text-leef" : " text-sell"}>
                    {" "}
                    {delta >= 0 ? "+" : ""}
                    {fmtNum(delta, { compact: true })}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {targets.length < 3 && (
        <Button variant="outline" size="sm" className="mt-2" disabled={running} onClick={addSlot}>
          Add treasure
        </Button>
      )}
    </Card>
  );
}

function RiskCard({ strategy, snap }: { strategy: BotStrategy; snap: LeefSnapshot }) {
  const risk = useBot((s) => s.risk);
  const quote = useBot((s) => s.quote);
  const position = useBot((s) => s.position);
  const setRisk = useBot((s) => s.setRisk);
  const notice = useBot((s) => s.riskMigrationNotice);
  const clearNotice = useBot((s) => s.clearRiskMigrationNotice);
  const [slidersOn, setSlidersOn] = useState(false);
  useEffect(() => setSlidersOn(true), []);
  const quoteSym = (quote || "WAX").toUpperCase();
  const quoteUsd =
    quoteSym === "WAX"
      ? snap.waxUsd
      : quoteSym === "LEEF"
        ? snap.leefUsd
        : snap.universe.find((u) => u.symbol === quoteSym)?.usdPrice ?? 0;
  const minTok = quoteUsd > 0 ? risk.minTradeUsd / quoteUsd : 0;
  const maxTok = quoteUsd > 0 ? risk.maxPositionUsd / quoteUsd : 0;
  // Wallet check: the bot can never size above what the wallet can actually
  // spend (spendable = balance − operational reserve) nor above the position
  // cap headroom. Show the binding constraint so limits are never a surprise.
  const balances = useWallet((s) => s.balances());
  const walletQuote = balanceForIdentifier(balances, snap.universe, quoteSym);
  const walletUsd = walletQuote * quoteUsd;
  const reserveUsd = risk.operationalReserveUsd ?? 0;
  const spendableUsd = Math.max(0, walletUsd - reserveUsd);
  const base = useBot((s) => s.base);
  const positionUsd = positionMarkUsd(position, snap, base || "LEEF");
  const headroomUsd = Math.max(0, risk.maxPositionUsd - positionUsd);
  const effectiveMaxUsd = Math.max(0, Math.min(risk.maxPositionUsd, spendableUsd, headroomUsd));
  const belowMin = effectiveMaxUsd + 1e-9 < risk.minTradeUsd;
  return (
    <Card className="p-4 sm:p-5">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-medium">
        <Waves className="size-4 text-accent" />
        Risk & sizing · USD value
      </h3>
      <p className="mb-4 text-xs text-muted-foreground">
        You set dollars. The engine converts to {quoteSym} at the live mark
        and still refuses trades whose costs eat the thesis.
      </p>
      {notice && (
        <p className="mb-3 rounded-md border border-warn/30 bg-warn/10 px-2 py-1.5 text-xs text-warn">
          {notice}{" "}
          <button type="button" className="underline" onClick={clearNotice}>
            dismiss
          </button>
        </p>
      )}
      <div className="space-y-3">
        <NumField
          label="Minimum trade value"
          suffix="USD"
          value={risk.minTradeUsd}
          min={0}
          max={100}
          step={1e-8}
          onChange={(minTradeUsd) =>
            setRisk({
              minTradeUsd,
              maxPositionUsd: Math.max(risk.maxPositionUsd, minTradeUsd),
            })
          }
        />
        <NumField
          label="Maximum position value"
          suffix="USD"
          value={risk.maxPositionUsd}
          min={0}
          max={10_000}
          step={0.01}
          onChange={(maxPositionUsd) =>
            setRisk({
              maxPositionUsd,
              minTradeUsd: Math.min(risk.minTradeUsd, maxPositionUsd),
            })
          }
        />
        <p className="text-xs text-muted-foreground">
          WAX is a micropayment chain — min can be $0 (one token quantum).
          Max covers $1–$100 clips. Staked CPU/NET/RAM = no transfer fee.
        </p>
        <p className="text-xs text-muted-foreground">
          {quoteUsd > 0
            ? `Current ${quoteSym}: $${quoteUsd < 0.01 ? quoteUsd.toExponential(3) : quoteUsd.toFixed(6)} · min ${minTok > 0 && minTok < 0.01 ? minTok.toExponential(3) : minTok.toFixed(4)} ${quoteSym} · max ${maxTok.toFixed(4)} ${quoteSym}`
            : `${quoteSym} has no USD mark — engine will sit out`}
        </p>
        {quoteUsd > 0 && (
          <p
            className={cn(
              "rounded-md border px-2 py-1.5 text-xs",
              belowMin
                ? "border-warn/30 bg-warn/10 text-warn"
                : "border-border bg-background text-muted-foreground",
            )}
          >
            Wallet check: {walletQuote.toFixed(4)} {quoteSym} ≈ ${walletUsd.toFixed(4)} · spendable $
            {spendableUsd.toFixed(4)} · effective max ${effectiveMaxUsd.toFixed(4)}
            {belowMin
              ? ` — below the $${risk.minTradeUsd < 0.01 ? risk.minTradeUsd.toExponential(2) : risk.minTradeUsd.toFixed(4)} minimum, so no trades will fire`
              : ""}
          </p>
        )}
        {strategy !== "unleashed" && (
          <>
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
          min={10}
          max={1800}
          step={5}
          format={(v) =>
            v < 60 ? `${v}s` : v % 60 === 0 ? `${v / 60}m` : `${Math.floor(v / 60)}m ${v % 60}s`
          }
          onChange={(cooldownSec) => setRisk({ cooldownSec })}
        />
        <Knob
          ready={slidersOn}
          label="Trades / hour"
          value={risk.maxTradesHour}
          min={1}
          max={120}
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
          </>
        )}
        {(strategy === "signal" || strategy === "auto") && (
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
        {(strategy === "spread" || strategy === "auto") && (
          <Knob
            ready={slidersOn}
            label="Min arb profit"
            value={risk.minEdgePct}
            min={0}
            max={10}
            step={0.05}
            format={(v) => `${v.toFixed(2)}%`}
            onChange={(minEdgePct) => setRisk({ minEdgePct })}
          />
        )}
        {(strategy === "grid" || strategy === "auto") && (
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
        {(strategy === "volume" || strategy === "volume-x" || strategy === "auto" || strategy === "unleashed") && (
          <Knob
            ready={slidersOn}
            label="Max echo loss per round trip"
            value={risk.maxEchoLossPct}
            min={0.1}
            max={5}
            step={0.1}
            format={(v) => `${v.toFixed(1)}%`}
            onChange={(maxEchoLossPct) => setRisk({ maxEchoLossPct })}
          />
        )}
        <Knob
          ready={slidersOn}
          label="Max hops"
          value={risk.maxHops ?? 4}
          min={1}
          max={10}
          step={1}
          format={(v) => `${Math.round(v)} hop${Math.round(v) === 1 ? "" : "s"}`}
          onChange={(maxHops) => setRisk({ maxHops: Math.round(maxHops) })}
        />
        <p className="text-xs text-muted-foreground">
          Min/max are a band, not an order size. Each clip is picked inside
          that band from the wallet and the route — $2 here, $0.001 there.
        </p>
      </div>
    </Card>
  );
}

function formatUsdDraft(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  if (Math.abs(n) >= 1) return String(n);
  const s = n.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

function parseUsdDraft(raw: string, min: number, max: number): number | null {
  const t = raw.trim().replace(",", ".");
  if (t === "" || t === "." || t === "0." || t === "-." || t.endsWith(".")) return null;
  if (/^0\.0+$/.test(t)) return 0;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
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
  const [draft, setDraft] = useState(() => formatUsdDraft(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(formatUsdDraft(value));
  }, [value, focused]);
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1 rounded-md border border-border bg-background px-2">
        <Input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          className="h-9 border-0 bg-transparent px-0 font-mono text-sm"
          value={draft}
          min={min}
          max={max}
          step={step}
          onFocus={() => setFocused(true)}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^\d.eE+-]/g, "");
            setDraft(raw);
            const n = parseUsdDraft(raw, min, max);
            if (n != null) onChange(n);
          }}
          onBlur={() => {
            setFocused(false);
            const n = parseUsdDraft(draft, min, max);
            if (n != null) {
              onChange(n);
              setDraft(formatUsdDraft(n));
            } else {
              setDraft(formatUsdDraft(value));
            }
          }}
        />
        <span className="text-xs text-subtle">{suffix}</span>
      </span>
    </label>
  );
}

function TokenSearch({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const needle = q.trim().toLowerCase();
  const shown = (needle ? options.filter((s) => s.toLowerCase().includes(needle)) : options).slice(
    0,
    40,
  );
  return (
    <label className="relative block text-xs text-muted-foreground">
      {label}
      <Input
        type="search"
        disabled={disabled}
        placeholder={value || `Search ${label.toLowerCase()}…`}
        value={open ? q : value}
        onFocus={() => {
          setOpen(true);
          setQ("");
        }}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 120);
        }}
        className="mt-1 h-9 font-mono text-sm"
        aria-label={`Search ${label}`}
        aria-expanded={open}
        autoComplete="off"
      />
      {open && !disabled && (
        <ul className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-md border border-border bg-background py-1 shadow-md">
          {shown.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-subtle">No match</li>
          ) : (
            shown.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full px-2 py-1.5 text-left font-mono text-sm",
                    s === value ? "bg-accent/15 text-foreground" : "text-foreground hover:bg-muted",
                  )}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(s);
                    setQ("");
                    setOpen(false);
                  }}
                >
                  {s}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
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
  const safe = Number.isFinite(value) ? value : min;
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums text-foreground">{format(safe)}</span>
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
          aria-label={label}
        />
      ) : (
        <div className="h-9" />
      )}
    </label>
  );
}
