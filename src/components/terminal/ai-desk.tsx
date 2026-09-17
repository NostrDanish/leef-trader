import { useCallback, useEffect, useState } from "react";
import {
  Brain,
  CheckCircle2,
  CircleDashed,
  Loader2,
  Save,
  ShieldOff,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  aiBudget,
  aiHealth,
  aiTask,
  AiError,
  DEFAULT_AI_GATEWAY,
  type AiResult,
  type AiTask,
} from "@/lib/leef/ai-analyst";
import { fmtNum, timeAgo } from "@/lib/leef/format";
import { journal } from "@/lib/leef/journal";
import { classifyRegime, dangerScore } from "@/lib/leef/regime";
import { isEconomicFailureReason } from "@/lib/wallet/trade-error";
import { getProfiles, injectArtifacts } from "@/lib/leef/learning-store";
import {
  DEFAULT_LEARNING_CONFIG,
  extractLearningArtifacts,
} from "@/lib/leef/learning";
import { autoReviewStatus, evidenceReviewContext } from "@/lib/leef/ai-review";
import type { LeefSnapshot } from "@/lib/leef/types";
import { useBot } from "@/store/bot";
import { useTerminal } from "@/store/terminal";
import { useToast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Compact context builders — scalars and short lists, never snapshots  */
/* ------------------------------------------------------------------ */

function marketContext(snap: LeefSnapshot): Record<string, unknown> {
  const b = useBot.getState();
  // Same regime + danger computation the bot desk shows and the engine
  // gates on — the analyst should see the engine's own risk read, not
  // invent a parallel one.
  const regime = classifyRegime({
    series: b.series,
    poolPricesUsd: snap.pools.map((p) => p.usdPerLeef ?? 0).filter((v) => v > 0),
  });
  const danger = dangerScore({
    quoteAgeMs: Math.max(0, Date.now() - Date.parse(snap.fetchedAt)),
    maxQuoteAgeMs: Math.max(15, b.risk.maxQuoteAgeSec) * 1000,
    volPct: regime.volPct,
    dislocationPct: regime.dislocationPct,
    liquidityUsd: Math.max(0, ...snap.pools.map((p) => p.tvlUsd)),
    recentFailures: b.decisions.filter(
      (d) =>
        d.kind === "error" &&
        isEconomicFailureReason(d.reason) &&
        Date.now() - Date.parse(d.t) < 600_000,
    ).length,
  });
  const topPools = [...snap.pools]
    .sort((a, c) => c.tvlUsd - a.tvlUsd)
    .slice(0, 6)
    .map((p) => ({
      pair: `LEEF/${p.pair.symbol}`,
      tvlUsd: Math.round(p.tvlUsd),
      volume24Usd: Math.round(p.volume24Usd),
      feePct: p.feePct,
      change24Pct: p.change24,
    }));
  const tape = snap.trades.slice(-8).map((t) => ({
    type: t.type,
    priceWax: t.priceWax,
    usd: Math.round(t.usdVolume * 100) / 100,
    time: t.time,
  }));
  return {
    market: {
      leefUsd: snap.leefUsd,
      waxUsd: snap.waxUsd,
      waxPerLeef: snap.waxPerLeef,
      waxOracleConfidence: snap.waxConfidence ?? null,
      waxOracleSources: snap.waxSources ?? null,
      waxDispersionPct: snap.waxDispersionPct ?? null,
      snapshotSource: snap.source,
      fetchedAt: snap.fetchedAt,
      onChainSpotAt: snap.spotAt ?? null,
      universeTokens: snap.universe.length,
    },
    topLeefPools: topPools,
    recentTape: tape,
    risk: {
      regime: regime.regime,
      regimeConfidence: regime.confidence,
      volPerPrintPct: regime.volPct,
      dislocationPct: regime.dislocationPct,
      dangerScore: danger.score,
      dangerBand: danger.band,
      entrySizeFactor: danger.sizeFactor,
      explain: [...regime.explain, ...danger.explain].slice(0, 8),
    },
    bot: {
      strategy: b.strategy,
      running: b.running,
      base: b.base,
      quote: b.quote,
      seriesPoints: b.series.length,
      recentDecisions: b.decisions
        .slice(0, 5)
        .map((d) => `${d.kind}: ${d.reason}`.slice(0, 140)),
    },
  };
}

function strategyContext(): Record<string, unknown> {
  const b = useBot.getState();
  const calibration = Object.entries(b.stats.byStrategy).map(([id, s]) => ({
    strategy: id,
    trades: s.trades,
    wins: s.wins,
    pnlUsd: Math.round(s.pnlUsd * 1000) / 1000,
    avgPredEdgePct: s.trades > 0 ? Math.round((s.predEdgePctSum / s.trades) * 1000) / 1000 : null,
    avgRealEdgePct: s.trades > 0 ? Math.round((s.realEdgePctSum / s.trades) * 1000) / 1000 : null,
    avgLatencyMs: s.trades > 0 ? Math.round(s.latencyMsSum / s.trades) : null,
  }));
  return {
    config: {
      strategy: b.strategy,
      base: b.base,
      quote: b.quote,
      growthTargets: b.growthTargets.map((t) => t.symbol),
      growthMode: b.growthMode,
      goals: b.goals,
      risk: b.risk,
    },
    session: {
      startedAt: new Date(b.stats.startedAt).toISOString(),
      startEquityUsd: b.stats.startEquityUsd,
      trades: b.stats.trades,
      wins: b.stats.wins,
      realizedUsd: Math.round(b.stats.realizedUsd * 1000) / 1000,
      volumeUsd: Math.round(b.stats.volumeUsd),
      echoCostUsd: Math.round(b.stats.echoCostUsd * 1000) / 1000,
    },
    position: b.position
      ? {
          baseAmount: b.position.amountLeef,
          entryUsd: b.position.entryUsd,
          entryCostUsd: b.position.entryCostUsd,
          highUsd: b.position.highUsd,
          since: new Date(b.position.since).toISOString(),
          mode: b.position.mode,
          strategy: b.position.strategy,
        }
      : null,
    calibration,
  };
}

/* ------------------------------------------------------------------ */
/* Result rendering — robust to whatever JSON shape the model returns   */
/* ------------------------------------------------------------------ */

const KEY_TITLES: Record<string, string> = {
  summary: "Summary",
  assessment: "Assessment",
  analysis: "Analysis",
  market_analysis: "Analysis",
  recommendation: "Recommendation",
  recommendations: "Recommendations",
  observations: "Observations",
  warnings: "Warnings",
  suggestions: "Suggestions",
  patterns: "Patterns",
  outlook: "Outlook",
  risks: "Risks",
  confidence: "Confidence",
  score: "Score",
  findings: "Findings",
  verdict: "Verdict",
  notes: "Notes",
};

function Value({ v }: { v: unknown }): React.ReactNode {
  if (v == null) return <span className="text-muted-foreground">—</span>;
  if (typeof v === "boolean") return <span>{v ? "true" : "false"}</span>;
  if (typeof v === "number") return <span className="tabular-nums">{fmtNum(v)}</span>;
  if (typeof v === "string") return <span className="whitespace-pre-wrap">{v}</span>;
  if (Array.isArray(v)) {
    return (
      <ul className="list-disc pl-5 space-y-1">
        {v.map((item, i) => (
          <li key={i}>
            <Value v={item} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof v === "object") {
    return (
      <div className="flex flex-col gap-1.5 border-l-2 border-border pl-3">
        {Object.entries(v as Record<string, unknown>).map(([k, val]) => (
          <div key={k}>
            <span className="text-xs font-medium text-muted-foreground">{k.replaceAll("_", " ")}</span>
            <div className="text-sm">
              <Value v={val} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return <span>{String(v)}</span>;
}

function AnalysisView({ result }: { result: AiResult }) {
  const obj =
    result.content && typeof result.content === "object" && !Array.isArray(result.content)
      ? (result.content as Record<string, unknown>)
      : { summary: result.content };
  const entries = Object.entries(obj).filter(([k]) => k !== "trade_authorization");
  return (
    <div className="flex flex-col gap-4">
      {entries.map(([k, v]) => (
        <div key={k}>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
            {KEY_TITLES[k] ?? k.replaceAll("_", " ")}
          </div>
          <div className="text-sm leading-relaxed">
            <Value v={v} />
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground pt-1 border-t">
        {result.model ? <span>{result.model}</span> : null}
        <span>{result.latencyMs} ms</span>
        <span>trade_authorization: false (enforced by the worker)</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Desk                                                                 */
/* ------------------------------------------------------------------ */

type RunState =
  | { status: "idle" }
  | { status: "running"; task: AiTask }
  | { status: "done"; task: AiTask; result: AiResult; at: number }
  | { status: "error"; task: AiTask; error: string; failure?: string; at: number };

function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url || DEFAULT_AI_GATEWAY;
  }
}

const TASKS: { id: AiTask; label: string; blurb: string }[] = [
  {
    id: "market_analysis",
    label: "Analyze market",
    blurb: "Live book, oracle quality, tape and the bot's recent decisions.",
  },
  {
    id: "strategy_analysis",
    label: "Review strategy",
    blurb: "Current config, session performance and calibration aggregates.",
  },
  {
    id: "evidence_review",
    label: "Review evidence",
    blurb: "The persistent journal: per-strategy evidence + gate-failure signatures.",
  },
];

export function AiDesk({ snap }: { snap: LeefSnapshot }) {
  const { toast } = useToast();
  const aiGatewayUrl = useTerminal((s) => s.aiGatewayUrl);
  const setAiGatewayUrl = useTerminal((s) => s.setAiGatewayUrl);
  const aiEnabled = useTerminal((s) => s.aiEnabled);
  const setAiEnabled = useTerminal((s) => s.setAiEnabled);
  const learningMode = useTerminal((s) => s.learningMode);
  const setLearningMode = useTerminal((s) => s.setLearningMode);
  const aiReviewEveryTrades = useTerminal((s) => s.aiReviewEveryTrades);
  const setAiReviewEveryTrades = useTerminal((s) => s.setAiReviewEveryTrades);
  const strategy = useBot((s) => s.strategy);
  const autoReview = autoReviewStatus();

  /** Unified 3-state: OFF / SUGGEST / CONTROLLED_LEARNING. */
  const aiMode: "off" | "suggest" | "controlled" = !aiEnabled
    ? "off"
    : learningMode === "controlled"
      ? "controlled"
      : "suggest";
  const setAiMode = (m: "off" | "suggest" | "controlled") => {
    if (m === "off") setAiEnabled(false);
    else {
      setAiEnabled(true);
      setLearningMode(m === "controlled" ? "controlled" : "suggest");
    }
  };

  const [urlDraft, setUrlDraft] = useState(aiGatewayUrl);
  const [health, setHealth] = useState<"unknown" | "checking" | "ok" | "down">("unknown");
  const [run, setRun] = useState<RunState>({ status: "idle" });
  const [, setBudgetTick] = useState(0);
  const budget = aiBudget();

  const checkHealth = useCallback(async () => {
    if (!useTerminal.getState().aiEnabled) return;
    setHealth("checking");
    setHealth((await aiHealth(aiGatewayUrl)) ? "ok" : "down");
  }, [aiGatewayUrl]);

  useEffect(() => {
    setHealth("unknown");
    void checkHealth();
  }, [checkHealth, aiEnabled]);

  const runTask = async (task: AiTask) => {
    if (!aiEnabled || run.status === "running") return;
    setRun({ status: "running", task });
    const t0 = Date.now();
    try {
      const data =
        task === "market_analysis"
          ? marketContext(snap)
          : task === "strategy_analysis"
            ? strategyContext()
            : await evidenceReviewContext();
      const result = await aiTask(task, data, { url: aiGatewayUrl });
      setRun({ status: "done", task, result, at: Date.now() });
      journal({
        kind: "ai",
        reason: `${task}: ok · ${result.raw.slice(0, 180)}`,
        latencyMs: Date.now() - t0,
      });
      if (task === "evidence_review") {
        // AI pattern discovery: typed proposals only, governor-validated,
        // shadow-first. The analyst discovers; statistics decide.
        const proposed = extractLearningArtifacts(
          result.content,
          getProfiles(),
          Date.now(),
          DEFAULT_LEARNING_CONFIG,
          { slippagePct: 0.05 },
        );
        if (proposed.length > 0) {
          const r = injectArtifacts(proposed);
          if (r.added > 0) {
            toast({
              title: `AI proposed ${r.added} learning artifact${r.added === 1 ? "" : "s"}`,
              description: "Shadow-testing on the Evidence desk — nothing is applied without proof.",
            });
          }
          if (r.rejected > 0) {
            toast({
              title: `Governor rejected ${r.rejected} AI proposal${r.rejected === 1 ? "" : "s"}`,
              description: "Failed schema, clamp, evidence or scope checks.",
              variant: "destructive",
            });
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AI call failed";
      const failure = err instanceof AiError ? err.failure : undefined;
      setRun({ status: "error", task, error: msg, failure, at: Date.now() });
      journal({ kind: "ai", reason: `${task}: failed · ${msg}`, latencyMs: Date.now() - t0 });
      if (failure === "rate_limited_local") {
        toast({ title: "Slow down", description: msg });
      }
    } finally {
      setBudgetTick((n) => n + 1);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-accent/10 p-2 text-accent">
              <Brain className="size-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">AI analyst</h2>
              <p className="text-sm text-muted-foreground max-w-prose">
                Your Cloudflare gateway ({hostLabel(aiGatewayUrl)}) sends a
                compact context to the model and returns structured commentary. The AI is an{" "}
                <span className="font-medium text-foreground">analyst, never the trading engine</span>{" "}
                — it cannot sign, cannot override a gate, and every response carries{" "}
                <code className="text-xs">trade_authorization: false</code>. The deterministic
                pipeline keeps trading if the gateway is down.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex rounded-lg border border-border overflow-hidden" role="radiogroup" aria-label="AI mode">
              {(
                [
                  ["off", "OFF"],
                  ["suggest", "SUGGEST"],
                  ["controlled", "CONTROLLED"],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={aiMode === m}
                  onClick={() => setAiMode(m)}
                  className={cn(
                    "px-2.5 py-1.5 text-xs transition-colors",
                    aiMode === m
                      ? "bg-accent/15 text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <Badge
              variant="outline"
              className={cn(
                "gap-1.5",
                health === "ok" && "border-leef/40 text-leef",
                health === "down" && "border-sell/40 text-sell",
              )}
            >
              {health === "checking" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : health === "ok" ? (
                <CheckCircle2 className="size-3" />
              ) : health === "down" ? (
                <XCircle className="size-3" />
              ) : (
                <CircleDashed className="size-3" />
              )}
              {health === "checking"
                ? "Checking…"
                : health === "ok"
                  ? "Gateway online"
                  : health === "down"
                    ? "Unreachable / CORS"
                    : "Gateway"}
            </Badge>
          </div>
        </div>

        {!aiEnabled ? (
          <div className="mt-4 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            AI is OFF — zero calls leave this browser. <span className="font-medium">SUGGEST</span>:
            analyst on demand, learning artifacts shadow until you promote them.{" "}
            <span className="font-medium">CONTROLLED</span>: the deterministic governor may
            auto-promote artifacts that beat their baseline on fresh evidence. Trading never
            depends on any of it.
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder={DEFAULT_AI_GATEWAY}
              className="max-w-md font-mono text-xs"
              aria-label="AI gateway URL"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setAiGatewayUrl(urlDraft);
                toast({ title: "Gateway saved", description: urlDraft.trim() || DEFAULT_AI_GATEWAY });
              }}
              disabled={urlDraft.trim() === aiGatewayUrl}
            >
              <Save className="size-4" />
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void checkHealth()}>
              Re-check
            </Button>
            <span className="text-xs text-muted-foreground ml-auto tabular-nums">
              Budget: {budget.remaining}/18 calls this minute
              {budget.resetInSec > 0 ? ` · resets in ${budget.resetInSec}s` : ""}
            </span>
          </div>
        )}

        {health === "down" && (
          <div className="mt-3 rounded-lg border border-warn/30 bg-warn/5 p-3 text-sm text-muted-foreground">
            If the worker is up but calls fail, this origin is probably not in its CORS allowlist.
            Add{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">
              {typeof location !== "undefined" ? location.origin : ""}
            </code>{" "}
            to the worker's allowed origins (Leef-signer dashboard → Security) and redeploy.
          </div>
        )}
      </Card>

      {aiEnabled && (
        <Card className="p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold">Auto-review</h3>
              <p className="text-sm text-muted-foreground">
                The analyst reads the evidence journal every N trades and proposes learning
                artifacts into the governor's shadow pipeline. Never per-trade, never blocking,
                never on the decision path — the engine trades on while it runs.
              </p>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Every</span>
              {[5, 10, 20].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setAiReviewEveryTrades(n)}
                  className={cn(
                    "rounded-md border px-2 py-1 tabular-nums",
                    aiReviewEveryTrades === n
                      ? "border-accent/40 bg-accent/10 text-accent"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {n}
                </button>
              ))}
              <span className="text-muted-foreground">trades</span>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className={cn(autoReview.inFlight && "border-accent/40 text-accent")}>
              {autoReview.inFlight ? "Reviewing…" : "Idle"}
            </Badge>
            <span>
              Last: {autoReview.lastReviewAt > 0 ? timeAgo(new Date(autoReview.lastReviewAt).toISOString()) : "never"}
              {" · "}{autoReview.note}
              {autoReview.lastProposalCount > 0 ? ` · ${autoReview.lastProposalCount} artifacts in shadow` : ""}
            </span>
          </div>
        </Card>
      )}

      {aiEnabled && (
        <div className="grid gap-4 md:grid-cols-3">
          {TASKS.map((t) => (
            <Card key={t.id} className="p-4 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold">{t.label}</h3>
                {run.status !== "idle" && run.task === t.id && run.status === "running" && (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                )}
              </div>
              <p className="text-sm text-muted-foreground flex-1">{t.blurb}</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void runTask(t.id)}
                disabled={run.status === "running" || budget.remaining <= 0}
              >
                {run.status === "running" && run.task === t.id ? "Analyzing (~30s)…" : "Run"}
              </Button>
            </Card>
          ))}
        </div>
      )}

      {run.status === "done" && (
        <Card className="p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2 mb-4">
            <h3 className="font-semibold">
              {TASKS.find((t) => t.id === run.task)?.label ?? run.task}
            </h3>
            <span className="text-xs text-muted-foreground">
              {timeAgo(new Date(run.at).toISOString())}
            </span>
          </div>
          <AnalysisView result={run.result} />
        </Card>
      )}

      {run.status === "error" && (
        <Card className="border-sell/30 bg-sell/5 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <ShieldOff className="size-5 text-sell shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-sell">
                {TASKS.find((t) => t.id === run.task)?.label ?? run.task} failed
              </h3>
              <p className="text-sm text-muted-foreground mt-1 max-w-prose">{run.error}</p>
              <p className="text-xs text-muted-foreground mt-2">
                Trading is unaffected — the deterministic engine never waits on the analyst.
              </p>
            </div>
          </div>
        </Card>
      )}

      {run.status === "idle" && (
        <Card className="border-dashed">
          <div className="py-10 px-8 text-center">
            <p className="text-muted-foreground max-w-md mx-auto text-sm">
              Run an analysis to get a second opinion on the market, the current strategy config
              ({strategy}), or the evidence journal. Every call is journaled so the analyst's own
              track record becomes reviewable too.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}
