import {
  BrainCircuit,
  CirclePlay,
  CircleStop,
  Loader2,
  ScanSearch,
  Sparkles,
  Waves,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { fmtNum, fmtUsd } from "@/lib/leef/format";
import { journal } from "@/lib/leef/journal";
import {
  GROWTH_MODES,
  snapshotTargets,
  targetUnitPnl,
  listTreasureTokens,
} from "@/lib/leef/growth-engine";
import { positionMarkUsd } from "@/lib/leef/risk-usd";
import {
  FOCUS_PRESETS,
  listBaseTokens,
  listQuoteTokens,
  suggestBotSettings,
  suggestPair,
  type AdvisorSuggestion,
} from "@/lib/leef/advisor";
import { dangerScore } from "@/lib/leef/regime";
import type { BotStrategy } from "@/lib/leef/bot-engine";
import { aiTask, extractGrowthTargets } from "@/lib/leef/ai-client";
import { aggregateFlowRisk, swapFlow } from "@/lib/market/swap-flow";
import { markPortfolioUsd } from "@/lib/wallet/balances";
import { balanceForIdentifier } from "@/lib/wallet/balances";
import { tokenPrice } from "@/lib/market/price-oracle";
import { snapFreshAtMs, type LeefSnapshot } from "@/lib/leef/types";
import { cn } from "@/lib/utils";
import { useBot } from "@/store/bot";
import { clampSyncSec, DEFAULT_SYNC_SEC, useTerminal } from "@/store/terminal";
import { useWallet } from "@/store/wallet";

export function BotDesk({ snap }: { snap: LeefSnapshot }) {
  const strategy = useBot((s) => s.strategy);
  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <div className="flex min-w-0 flex-col gap-5 lg:col-span-3">
        <BotHeader snap={snap} />
        {strategy === "growth" ? (
          <GrowthPnlCards snap={snap} />
        ) : (
          <PnlCards snap={snap} />
        )}
        <DecisionFeed />
      </div>
      <div className="flex min-w-0 flex-col gap-5 lg:col-span-2">
        <AdvisorCard snap={snap} />
        {strategy === "growth" && <TreasureCard snap={snap} />}
        <RiskCard strategy={strategy} snap={snap} />
        <GoalsCard />
      </div>
    </div>
  );
}

function BotHeader({ snap }: { snap: LeefSnapshot }) {
  const b = useBot();
  const w = useWallet();
  const mode = w.canSign() ? "live" : "paper";
  const equityUsd = markPortfolioUsd(snap, w.balances()).totalUsd;
  const halt = useBot((s) => s.strategyHalt);

  return (
    <Card className="p-4 sm:p-5">
      {halt && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sell/40 bg-sell/10 px-3 py-2 text-xs text-sell">
          <div>
            <p className="font-medium">Strategy halted — manual resume required</p>
            <p className="text-sell/80">
              {halt.reason} · {new Date(halt.at).toLocaleTimeString()} — repeated
              identical on-chain reverts risk a 24h account greylist, so the bot
              stopped itself.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              b.resumeStrategy();
              b.start(equityUsd);
            }}
          >
            Resume {halt.strategy}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
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
                  b.running ? "bg-leef" : "bg-subtle",
                )}
              />
            </span>
            <h2 className="text-base font-medium tracking-tight">
              Trade engine <span className="text-muted-foreground">· {b.strategy}</span>
            </h2>
            <DangerBadge snap={snap} />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {b.lastReason}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={mode === "live" ? "leef" : "warn"}>
            {mode === "live" ? "Live" : "Paper"}
          </Badge>
          {b.running ? (
            <Button variant="danger" size="sm" onClick={() => b.stop()}>
              <CircleStop className="size-4" />
              Stop
            </Button>
          ) : (
            <Button variant="leef" size="sm" onClick={() => b.start(equityUsd)}>
              <CirclePlay className="size-4" />
              Start {mode}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function PnlCards({ snap }: { snap: LeefSnapshot }) {
  const b = useBot();
  const w = useWallet();
  const equityUsd = markPortfolioUsd(snap, w.balances()).totalUsd;
  const sessionPnl = equityUsd - b.stats.startEquityUsd;
  const trades = b.stats.trades;
  const winRate = trades > 0 ? b.stats.wins / trades : 0;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Card className="p-4">
        <div className="text-xs uppercase tracking-wider text-subtle">Session P&L</div>
        <div
          className={cn(
            "mt-1 font-mono text-lg tabular-nums",
            sessionPnl >= 0 ? "text-buy" : "text-sell",
          )}
        >
          {sessionPnl >= 0 ? "+" : ""}
          {fmtUsd(sessionPnl, 2)}
        </div>
        <div className="text-xs text-muted-foreground">
          realized {b.stats.realizedUsd >= 0 ? "+" : ""}
          {fmtUsd(b.stats.realizedUsd, 2)}
        </div>
      </Card>
      <Card className="p-4">
        <div className="text-xs uppercase tracking-wider text-subtle">Win rate</div>
        <div className="mt-1 font-mono text-lg tabular-nums">
          {(winRate * 100).toFixed(0)}%
        </div>
        <div className="text-xs text-muted-foreground">
          {b.stats.wins}/{trades} trades
        </div>
      </Card>
      <Card className="p-4">
        <div className="text-xs uppercase tracking-wider text-subtle">Position</div>
        <div className="mt-1 font-mono text-lg tabular-nums">
          {b.position ? fmtNum(b.position.amountLeef, { compact: true }) : "Flat"}
        </div>
        <PositionPnl snap={snap} />
        {!b.position && (
          <SessionStartBalances snap={snap} />
        )}
      </Card>
      <Card className="p-4">
        <div className="text-xs uppercase tracking-wider text-subtle">Volume</div>
        <div className="mt-1 font-mono text-lg tabular-nums">
          {fmtUsd(b.stats.volumeUsd, 2)}
        </div>
        <div className="text-xs text-muted-foreground">
          echo cost {fmtUsd(b.stats.echoCostUsd, 2)}
        </div>
      </Card>
    </div>
  );
}

/**
 * Holdings delta vs session start — swap-style strategies (volume, unleashed)
 * never open a tracked Position, so the card shows what the wallet actually
 * gained instead of a misleading "Flat".
 */
function SessionStartBalances({ snap }: { snap: LeefSnapshot }) {
  const start = useBot((s) => s.sessionStartBalances);
  const balances = useWallet((s) => s.balances());
  const syms = Object.keys(start);
  if (syms.length === 0) return null;
  const rows = syms
    .map((sym) => {
      const now = balanceForIdentifier(balances, snap.universe, sym);
      const delta = now - (start[sym] ?? 0);
      return { sym, delta };
    })
    .filter((r) => Math.abs(r.delta) > 1e-8)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 3);
  if (rows.length === 0) return null;
  return (
    <div className="mt-3 border-t border-border pt-2 font-mono text-xs text-subtle">
      {rows.map((r) => (
        <div key={r.sym} className={r.delta >= 0 ? "text-buy" : "text-sell"}>
          {r.delta >= 0 ? "+" : ""}
          {fmtNum(r.delta, { compact: true })} {r.sym}
        </div>
      ))}
    </div>
  );
}

function DangerBadge({ snap }: { snap: LeefSnapshot }) {
  const b = useBot();
  const syncSec = clampSyncSec(useTerminal.getState().syncSec ?? DEFAULT_SYNC_SEC);
  const quoteAgeMs = Math.max(0, Date.now() - snapFreshAtMs(snap));
  const flowStates = useTerminal.getState().flowGuardEnabled
    ? swapFlow.tracker.allStates(Date.now())
    : null;
  const danger = dangerScore({
    quoteAgeMs,
    maxQuoteAgeMs: Math.max(b.risk.maxQuoteAgeSec, syncSec + 15) * 1000,
    liquidityUsd: Math.max(0, ...snap.pools.map((p) => p.tvlUsd)),
    recentFailures: b.decisions.filter(
      (d) => d.kind === "error" && Date.now() - Date.parse(d.t) < 600_000,
    ).length,
    flow: flowStates
      ? aggregateFlowRisk(flowStates, Math.max(b.risk.maxQuoteAgeSec, syncSec + 15) * 1000)
      : null,
  });
  const tone =
    danger.band === "ok"
      ? "border-leef/40 text-leef"
      : danger.band === "caution"
        ? "border-warn/40 text-warn"
        : "border-sell/40 text-sell";
  const dangerTone = tone;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn("rounded-full border px-2 py-0.5 font-mono normal-case tracking-normal", dangerTone)}
        title={danger.explain.join("\n")}
      >
        danger {danger.score}
      </span>
    </span>
  );
}

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
        Any pair on any book — WAX/TLM, LEEF/USDC, TACO/WUF, whatever exists.
        LEEF is the default beneficiary (routes through it win near-ties; the
        volume engine prefers it when costs allow), never a requirement and
        never at a loss. Scan sizes from this wallet and CPU/NET/RAM. You apply.
      </p>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <TokenSearch
          label="Base — any token"
          value={base}
          options={bases}
          disabled={running}
          onChange={(v) => {
            setBase(v);
            setScan(null);
          }}
        />
        <TokenSearch
          label="Quote — any token"
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

function GrowthPnlCards({ snap }: { snap: LeefSnapshot }) {
  const targets = useBot((s) => s.growthTargets);
  const start = useBot((s) => s.growthStart);
  const balances = useWallet((s) => s.balances());
  const rows = targetUnitPnl(snap, balances, targets, start);
  const equityUsd = markPortfolioUsd(snap, balances).totalUsd;
  const startEq = useBot((s) => s.stats.startEquityUsd);
  const trades = useBot((s) => s.stats.trades);
  const wins = useBot((s) => s.stats.wins);
  const winRate = trades > 0 ? wins / trades : 0;
  const valueDelta = equityUsd - startEq;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {rows.map((r) => (
        <Card key={r.symbol} className="border-l-2 border-l-leef p-4">
          <div className="text-xs uppercase tracking-wider text-subtle">{r.symbol} growth</div>
          <div className={cn("mt-1 font-mono text-lg tabular-nums", r.delta >= 0 ? "text-leef" : "text-sell")}>
            {r.delta >= 0 ? "+" : ""}
            {fmtNum(r.delta, { compact: true })}
          </div>
          <div className="text-xs text-muted-foreground">
            {fmtNum(r.now, { compact: true })} now · {fmtUsd(r.usdNow)} · {r.weight.toFixed(0)}% mix
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-leef"
              style={{ width: `${Math.min(100, Math.max(4, r.weight))}%` }}
            />
          </div>
        </Card>
      ))}
      <Card className="p-4">
        <div className="text-xs uppercase tracking-wider text-subtle">Portfolio value</div>
        <div className={cn("mt-1 font-mono text-lg tabular-nums", valueDelta >= 0 ? "text-buy" : "text-sell")}>
          {valueDelta >= 0 ? "+" : ""}
          {fmtUsd(valueDelta, 2)}
        </div>
        <div className="text-xs text-muted-foreground">
          {fmtUsd(equityUsd, 2)} · {trades} trades · {(winRate * 100).toFixed(0)}% win
        </div>
      </Card>
    </div>
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
  const activeMode = GROWTH_MODES.find((m) => m.id === mode) ?? GROWTH_MODES[1]!;
  const aiEnabled = useTerminal((s) => s.aiEnabled);
  const aiGatewayUrl = useTerminal((s) => s.aiGatewayUrl);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPick, setAiPick] = useState<{ symbol: string; weight: number }[] | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);

  /**
   * AI-assisted treasure mix: the analyst RANKS candidates from liquid
   * universe tokens; a human applies the mix. The growth engine then trades
   * it through the same deterministic gates as everything else — the AI
   * never touches the trade path.
   */
  async function askAiForMix() {
    if (aiBusy || !aiEnabled) return;
    setAiBusy(true);
    setAiPick(null);
    setAiNote(null);
    const t0 = Date.now();
    try {
      const candidates = choices.slice(0, 24);
      const candData = candidates.map((symbol) => {
        const u = snap.universe.find((t) => t.symbol === symbol);
        return {
          symbol,
          tvlUsd: Math.round(u?.tvlUsd ?? 0),
          volume24Usd: Math.round(u?.volume24Usd ?? 0),
          usdPrice: u?.usdPrice ?? null,
          trusted: u?.alcorTrusted ?? false,
          scam: u?.alcorScam ?? false,
        };
      });
      const res = await aiTask(
        "strategy_analysis",
        {
          mode: "growth_target_selection",
          instruction:
            "Pick 1-5 tokens from `candidates` to ACCUMULATE over the coming weeks (a treasure mix). " +
            "Prefer liquid, venue-trusted tokens; exclude scam-flagged ones; LEEF may be included when sensible. " +
            "Reply in JSON including a `targets` array of {symbol, weight} whose weights sum to 100, plus a short `reason`.",
          currentTargets: targets,
          walletUsd: Math.round(markPortfolioUsd(snap, balances).totalUsd * 100) / 100,
          candidates: candData,
        },
        { url: aiGatewayUrl },
      );
      journal({
        kind: "ai",
        reason: `growth_target_selection: ok · ${res.raw.slice(0, 160)}`,
        latencyMs: Date.now() - t0,
      });
      const pick = extractGrowthTargets(res.content, candidates);
      if (!pick) {
        setAiNote("The analyst answered, but no usable token mix was found in its reply. Try again or pick manually.");
      } else {
        setAiPick(pick);
        const reason = (res.content as { reason?: unknown })?.reason;
        setAiNote(typeof reason === "string" ? reason.slice(0, 240) : null);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AI call failed";
      journal({ kind: "ai", reason: `growth_target_selection: failed · ${msg}`, latencyMs: Date.now() - t0 });
      setAiNote(msg);
    } finally {
      setAiBusy(false);
    }
  }

  function setSlot(i: number, symbol: string) {
    const next = targets.map((t, j) => (j === i ? { ...t, symbol } : t));
    setTargets(next);
  }
  function setWeight(i: number, weight: number) {
    const next = targets.map((t, j) => (j === i ? { ...t, weight } : t));
    setTargets(next);
  }
  function addSlot() {
    if (targets.length >= 5) return;
    const used = new Set(targets.map((t) => t.symbol));
    const extra = choices.find((c) => !used.has(c)) ?? "LEEF";
    setTargets([...targets, { symbol: extra, weight: 10 }]);
  }
  function removeSlot(i: number) {
    if (targets.length <= 1) return;
    setTargets(targets.filter((_, j) => j !== i));
  }

  const walletUsd = markPortfolioUsd(snap, balances).totalUsd;
  const targetUsd = now.reduce((s, n) => s + n.usd, 0);
  const workingUsd = Math.max(0, walletUsd - targetUsd);

  return (
    <Card className="p-4 sm:p-5">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-medium">
        <BrainCircuit className="size-4 text-leef" />
        Treasure
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Name 1–5 assets to grow. Token count is the objective; economic value
        is a constraint. The bot never promises growth — it seeks positive
        expected target growth and HOLDs when the book does not offer it.
      </p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {GROWTH_MODES.map((m) => (
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
      <p className="mb-3 text-xs text-subtle">{activeMode.detail}</p>
      <div className="space-y-2">
        {targets.map((t, i) => {
          const live = now.find((n) => n.symbol === t.symbol);
          const opened = start[t.symbol];
          const delta = live && opened != null ? live.amount - opened : null;
          const share = live ? live.sharePct : 0;
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
                {live && (
                  <span className="text-subtle">
                    {" "}
                    · wallet {share.toFixed(0)}% vs {t.weight.toFixed(0)}%
                    {live.gapPct > 1 ? " under" : live.gapPct < -1 ? " over" : ""}
                  </span>
                )}
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-accent/80"
                  style={{ width: `${Math.min(100, Math.max(2, share))}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {targets.length < 5 && (
          <Button variant="outline" size="sm" disabled={running} onClick={addSlot}>
            Add treasure
          </Button>
        )}
        {aiEnabled && (
          <Button
            variant="outline"
            size="sm"
            disabled={running || aiBusy}
            onClick={() => void askAiForMix()}
            title="The analyst suggests a mix from liquid, trusted universe tokens — you apply it, the engine trades it through the normal gates"
          >
            {aiBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            {aiBusy ? "Asking…" : "Ask AI for a mix"}
          </Button>
        )}
      </div>
      {(aiPick || aiNote) && (
        <div className="mt-2 rounded-lg border border-accent/30 bg-accent/5 p-3">
          {aiPick ? (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {aiPick.map((t) => (
                  <Badge key={t.symbol} variant="accent" className="font-mono">
                    {t.symbol} · {Math.round(t.weight)}%
                  </Badge>
                ))}
              </div>
              {aiNote && <p className="mb-2 text-xs text-muted-foreground">{aiNote}</p>}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="leef"
                  disabled={running}
                  onClick={() => {
                    setTargets(aiPick);
                    setAiPick(null);
                    setAiNote(null);
                  }}
                >
                  Use this mix
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAiPick(null)}>
                  Dismiss
                </Button>
              </div>
              <p className="mt-2 text-[11px] text-subtle">
                Advisory only — applying just changes the treasure list. Every trade still passes
                the deterministic net-edge, exact-quote, governor and firewall gates.
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{aiNote}</p>
          )}
        </div>
      )}
      <p className="mt-3 border-t border-border pt-2 font-mono text-xs text-subtle">
        Working capital {fmtUsd(workingUsd)} (everything not in the mix) · wallet {fmtUsd(walletUsd)}
      </p>
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
  // Same gated oracle the engine sizes with (requireTradePrice rides this):
  // never convert at a stale or non-tradeable mark the engine would refuse,
  // and never read the first same-symbol universe row (clone contracts).
  const quoteMark = tokenPrice(snap, quoteSym);
  const quoteUsd = quoteMark?.priceUsd ?? 0;
  const quoteTradeAllowed = quoteMark?.tradeAllowed ?? false;
  // For anchored stables the sizing mark can differ from the venue print —
  // show both so the conversion is never a surprise.
  const marketNote =
    quoteMark?.marketPriceUsd != null &&
    quoteUsd > 0 &&
    Math.abs(quoteMark.marketPriceUsd - quoteUsd) / quoteUsd > 0.001
      ? ` (market $${quoteMark.marketPriceUsd < 0.01 ? quoteMark.marketPriceUsd.toExponential(3) : quoteMark.marketPriceUsd.toFixed(4)})`
      : "";
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
            ? `Current ${quoteSym}: $${quoteUsd < 0.01 ? quoteUsd.toExponential(3) : quoteUsd.toFixed(6)}${marketNote} · min ${minTok > 0 && minTok < 0.01 ? minTok.toExponential(3) : minTok.toFixed(4)} ${quoteSym} · max ${maxTok > 0 && maxTok < 0.01 ? maxTok.toExponential(3) : maxTok.toFixed(4)} ${quoteSym}`
            : `${quoteSym} has no USD mark — engine will sit out`}
          {quoteUsd > 0 && !quoteTradeAllowed && quoteMark
            ? ` · mark not tradeable — ${quoteMark.reason}`
            : ""}
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
            Wallet check: {fmtNum(walletQuote)} {quoteSym} ≈ {fmtUsd(walletUsd)} · spendable{" "}
            {fmtUsd(spendableUsd)} · effective max {fmtUsd(effectiveMaxUsd)}
            {belowMin
              ? ` — below the ${fmtUsd(risk.minTradeUsd)} minimum, so no trades will fire`
              : ""}
          </p>
        )}
        {(() => {
          const st = useBot.getState();
          const spent = st.stats.echoCostUsd;
          const cap = st.risk.echoBudgetUsd ?? 0;
          if (cap <= 0 || spent < cap) return null;
          return (
            <p className="rounded-md border border-warn/30 bg-warn/10 px-2 py-1.5 text-xs text-warn">
              Echo budget spent ({fmtUsd(spent)} / {fmtUsd(cap)}) — volume intents
              are off.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => st.resetSession(markPortfolioUsd(snap, useWallet.getState().balances()).totalUsd)}
              >
                Reset session
              </button>{" "}
              to clear it, or raise the budget above.
            </p>
          );
        })()}
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
        {(strategy === "volume" || strategy === "auto" || strategy === "unleashed") && (
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
        {(strategy === "volume" || strategy === "auto" || strategy === "unleashed") && (
          <Knob
            ready={slidersOn}
            label="Volume gate — third-party swap freshness (0 = off)"
            value={risk.volumeFlowGateMin}
            min={0}
            max={60}
            step={1}
            format={(v) => (v <= 0 ? "off" : `${Math.round(v)}m`)}
            onChange={(volumeFlowGateMin) => setRisk({ volumeFlowGateMin })}
          />
        )}
        {(strategy === "volume" || strategy === "auto" || strategy === "unleashed") && (
          <Knob
            ready={slidersOn}
            label="Session echo budget (0 = unlimited)"
            value={risk.echoBudgetUsd}
            min={0}
            max={50}
            step={1}
            format={(v) => (v <= 0 ? "unlimited" : `$${Math.round(v)}`)}
            onChange={(echoBudgetUsd) => setRisk({ echoBudgetUsd })}
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
