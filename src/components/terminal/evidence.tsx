import { useCallback, useEffect, useState } from "react";
import { DatabaseZap, Download, FlaskConical, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtNum, fmtUsd, timeAgo } from "@/lib/leef/format";
import {
  aggregateEntries,
  journalAll,
  journalClear,
  journalExportBlob,
  listFixtures,
  MAX_ENTRIES,
  type EvidenceStats,
  type MarketFixture,
} from "@/lib/leef/journal";
import { replayAll, type ReplayResult, type ReplaySummary } from "@/lib/leef/replay";
import {
  bootLearning,
  getArtifacts,
  getProfiles,
  promoteArtifact,
  refreshProposals,
  rollbackArtifactById,
} from "@/lib/leef/learning-store";
import {
  bucketMeanEdge,
  DEFAULT_LEARNING_CONFIG,
  SIZE_BUCKET_LABELS,
  type LearningArtifact,
  type LearningProfiles,
} from "@/lib/leef/learning";
import { useTerminal } from "@/store/terminal";
import { useWallet } from "@/store/wallet";
import { backfillAccountHistory } from "@/lib/wallet/history-backfill";
import { useToast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";

function fmtPctSigned(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function spanLabel(stats: EvidenceStats): string {
  if (stats.oldestTs == null || stats.newestTs == null) return "—";
  const ms = stats.newestTs - stats.oldestTs;
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

/**
 * Evidence desk — the trader's memory, made visible. Every decision, gate
 * verdict, execution and calibration pair the bot has recorded, aggregated
 * per strategy. This is the dataset that answers "does this actually make
 * money?" — and the gate-failure table answers "does CP discovery disagree
 * with venue CLMM math often enough to justify tick-level discovery?"
 */
export function Evidence() {
  const { toast } = useToast();
  const learningMode = useTerminal((s) => s.learningMode);
  const setLearningMode = useTerminal((s) => s.setLearningMode);
  const [stats, setStats] = useState<EvidenceStats | null>(null);
  const [profiles, setProfiles] = useState<LearningProfiles>({});
  const [artifacts, setArtifacts] = useState<LearningArtifact[]>([]);
  const [fixtures, setFixtures] = useState<MarketFixture[]>([]);
  const [replay, setReplay] = useState<{ summary: ReplaySummary; results: (ReplayResult & { ts: number })[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const account = useWallet((s) => s.account);

  const doBackfill = async () => {
    if (!account) return;
    setBackfilling(true);
    try {
      const r = await backfillAccountHistory({ account });
      toast({
        title: "Chain backfill",
        description: `${r.note} · scanned ${fmtNum(r.scanned, { digits: 0 })} actions, ${r.skippedDupe} already known, ${r.skippedShape} non-swap shaped`,
      });
      await refresh();
    } finally {
      setBackfilling(false);
    }
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const entries = await journalAll();
      await bootLearning(entries);
      refreshProposals();
      setStats(aggregateEntries(entries));
      setProfiles({ ...getProfiles() });
      setArtifacts(getArtifacts());
      const fx = await listFixtures(30);
      setFixtures(fx);
      setReplay(fx.length > 0 ? replayAll(fx) : null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doExport = async () => {
    setExporting(true);
    try {
      const { blob, count } = await journalExportBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "");
      a.href = url;
      a.download = `leef-evidence-${stamp}.ndjson`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Evidence exported", description: `${fmtNum(count, { digits: 0 })} entries (NDJSON)` });
    } finally {
      setExporting(false);
    }
  };

  const doClear = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    await journalClear();
    toast({ title: "Evidence cleared", description: "The journal is empty. Trading state was not touched." });
    await refresh();
  };

  const totals = stats
    ? stats.byStrategy.reduce(
        (acc, s) => ({
          decisions: acc.decisions + s.decisions,
          executions: acc.executions + s.executions,
          pnlUsd: acc.pnlUsd + s.pnlUsd,
          gatePass: acc.gatePass + s.gatePass,
          gateFail: acc.gateFail + s.gateFail,
        }),
        { decisions: 0, executions: 0, pnlUsd: 0, gatePass: 0, gateFail: 0 },
      )
    : null;
  const gateRate =
    totals && totals.gatePass + totals.gateFail > 0
      ? (totals.gatePass / (totals.gatePass + totals.gateFail)) * 100
      : null;

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-leef/10 p-2 text-leef">
              <FlaskConical className="size-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Evidence journal</h2>
              <p className="text-sm text-muted-foreground max-w-prose">
                Append-only record of every decision, exact-quote gate verdict, execution and
                predicted-vs-realized edge. Persists in this browser across sessions; export it
                before clearing site data. "Backfill chain" imports your past swaps from Hyperion
                (EOSUSA-first history pool) — labeled <code>backfill</code>, never fed into
                learning profiles (hindsight carries no predictions).
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void doBackfill()}
              disabled={backfilling || !account}
              title="Import your past swaps from Hyperion (EOSUSA-first history pool). Backfilled rows are labeled and never feed learning profiles."
            >
              {backfilling ? <Loader2 className="size-4 animate-spin" /> : <DatabaseZap className="size-4" />}
              Backfill chain
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void doExport()}
              disabled={exporting || !stats || stats.entries === 0}
            >
              {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              Export NDJSON
            </Button>
            <Button
              variant={confirmClear ? "destructive" : "outline"}
              size="sm"
              onClick={() => void doClear()}
              disabled={!stats || stats.entries === 0}
            >
              <Trash2 className="size-4" />
              {confirmClear ? "Really clear?" : "Clear"}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { label: "Entries", value: stats ? fmtNum(stats.entries, { digits: 0 }) : "—", sub: `cap ${fmtNum(MAX_ENTRIES, { compact: true })}` },
            { label: "Span", value: stats ? spanLabel(stats) : "—", sub: stats?.newestTs ? `latest ${timeAgo(new Date(stats.newestTs).toISOString())}` : "" },
            { label: "Decisions", value: totals ? fmtNum(totals.decisions, { digits: 0 }) : "—", sub: "incl. HOLDs" },
            { label: "Executions", value: totals ? fmtNum(totals.executions, { digits: 0 }) : "—", sub: "paper + live" },
            {
              label: "Gate pass rate",
              value: gateRate != null ? `${gateRate.toFixed(0)}%` : "—",
              sub:
                stats && stats.gateDrift.n > 0
                  ? `model↔venue drift ${stats.gateDrift.meanPct >= 0 ? "+" : ""}${stats.gateDrift.meanPct.toFixed(2)}% (|${stats.gateDrift.meanAbsPct.toFixed(2)}%|) × ${fmtNum(stats.gateDrift.n, { digits: 0 })}`
                  : "exact-quote gate",
            },
            {
              label: "Realized P&L",
              value: totals ? fmtUsd(totals.pnlUsd) : "—",
              sub: "journaled trades",
            },
          ].map((c) => (
            <div key={c.label} className="rounded-lg border bg-card/50 p-3">
              <div className="text-xs text-muted-foreground">{c.label}</div>
              <div className="text-xl font-semibold tabular-nums">{c.value}</div>
              {c.sub ? <div className="text-[11px] text-muted-foreground">{c.sub}</div> : null}
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-4 sm:p-5">
        <h3 className="font-semibold mb-1">Per strategy</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Calibration error = mean predicted edge − mean realized edge. Positive means the
          strategy over-predicts; near zero means the cost model is honest.
        </p>
        {!stats || stats.byStrategy.length === 0 ? (
          <div className="rounded-lg border border-dashed py-12 px-8 text-center">
            <p className="text-muted-foreground max-w-sm mx-auto">
              No evidence yet. Start the bot — every decision, gate verdict and fill lands here
              from now on.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Strategy</TableHead>
                  <TableHead className="text-right">Decisions</TableHead>
                  <TableHead className="text-right">HOLDs</TableHead>
                  <TableHead className="text-right">Trades</TableHead>
                  <TableHead className="text-right">Win rate</TableHead>
                  <TableHead className="text-right">P&amp;L</TableHead>
                  <TableHead className="text-right">Pred edge</TableHead>
                  <TableHead className="text-right">Real edge</TableHead>
                  <TableHead className="text-right">Calib. error</TableHead>
                  <TableHead className="text-right">Gate ✓/✗</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.byStrategy.map((s) => {
                  const predAvg = s.predN > 0 ? s.predEdgePctSum / s.predN : null;
                  const realAvg = s.realN > 0 ? s.realEdgePctSum / s.realN : null;
                  const calibErr = predAvg != null && realAvg != null ? predAvg - realAvg : null;
                  const winRate = s.executions > 0 ? (s.wins / s.executions) * 100 : null;
                  return (
                    <TableRow key={s.strategy}>
                      <TableCell className="font-medium">
                        {s.strategy}
                        {s.unknown > 0 && (
                          <Badge variant="outline" className="ml-2 text-warn border-warn/40">
                            {s.unknown} unknown tx
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(s.decisions, { digits: 0 })}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{fmtNum(s.holds, { digits: 0 })}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtNum(s.executions, { digits: 0 })}
                        {s.paper > 0 && (
                          <span className="text-muted-foreground"> ({fmtNum(s.paper, { digits: 0 })}p)</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {winRate != null ? `${winRate.toFixed(0)}%` : "—"}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          s.pnlUsd > 0 ? "text-leef" : s.pnlUsd < 0 ? "text-sell" : "",
                        )}
                      >
                        {fmtUsd(s.pnlUsd)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{predAvg != null ? fmtPctSigned(predAvg) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{realAvg != null ? fmtPctSigned(realAvg) : "—"}</TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          calibErr != null && Math.abs(calibErr) > 0.5 ? "text-warn" : "",
                        )}
                      >
                        {calibErr != null ? fmtPctSigned(calibErr) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className="text-leef">{s.gatePass}</span>
                        <span className="text-muted-foreground"> / </span>
                        <span className={s.gateFail > 0 ? "text-sell" : ""}>{s.gateFail}</span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {stats && (stats.counterfactuals.trueHolds + stats.counterfactuals.falseHolds + stats.counterfactuals.neutral) > 0 && (
        <Card className="p-4 sm:p-5">
          <h3 className="font-semibold mb-1">Counterfactual HOLDs</h3>
          <p className="text-sm text-muted-foreground mb-4">
            What happened after the engine said no. Measured against real market data 5 minutes
            after each veto — <span className="font-medium">labeled model-based</span> (price mark
            or local re-quote), never a claimed fill. These judge the thesis, not risk policy.
          </p>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg border bg-card/50 p-3 text-center">
              <div className="text-2xl font-semibold tabular-nums text-leef">
                {stats.counterfactuals.trueHolds}
              </div>
              <div className="text-xs text-muted-foreground">TRUE_HOLD · holding was right</div>
            </div>
            <div className="rounded-lg border bg-card/50 p-3 text-center">
              <div className="text-2xl font-semibold tabular-nums text-sell">
                {stats.counterfactuals.falseHolds}
              </div>
              <div className="text-xs text-muted-foreground">FALSE_HOLD · opportunity was real</div>
            </div>
            <div className="rounded-lg border bg-card/50 p-3 text-center">
              <div className="text-2xl font-semibold tabular-nums text-muted-foreground">
                {stats.counterfactuals.neutral}
              </div>
              <div className="text-xs text-muted-foreground">Neutral · inside noise band</div>
            </div>
          </div>
        </Card>
      )}

      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
          <h3 className="font-semibold">Pool learning</h3>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Learning mode</span>
            <button
              type="button"
              onClick={() => setLearningMode(learningMode === "suggest" ? "controlled" : "suggest")}
              className={cn(
                "rounded-full border px-2.5 py-1",
                learningMode === "controlled"
                  ? "border-accent/50 bg-accent/15 text-foreground"
                  : "border-border text-muted-foreground",
              )}
            >
              {learningMode === "controlled" ? "CONTROLLED — governor may auto-promote" : "SUGGEST — human promotes"}
            </button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Deterministic statistics over the journal, per pool × size bucket. Profiles never touch
          the engine directly — only governor-promoted artifacts adjust anything (slippage estimate
          clamped {DEFAULT_LEARNING_CONFIG.slipClampMinPct}–{DEFAULT_LEARNING_CONFIG.slipClampMaxPct}%,
          size ceilings can only shrink).
        </p>
        {Object.values(profiles).filter((p) => p.kind === "pool" && p.executions > 0).length === 0 ? (
          <div className="rounded-lg border border-dashed py-10 px-8 text-center">
            <p className="text-muted-foreground max-w-md mx-auto text-sm">
              No pool evidence yet. Profiles build up as executions with confirmed outcomes land in
              the journal.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pool</TableHead>
                  <TableHead className="text-right">Samples</TableHead>
                  <TableHead className="text-right">Realized slip</TableHead>
                  <TableHead>Size curve (mean realized edge)</TableHead>
                  <TableHead className="text-right">Gate fails</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.values(profiles)
                  .filter((p) => p.kind === "pool" && p.executions > 0)
                  .sort((a, b) => b.executions - a.executions)
                  .slice(0, 10)
                  .map((p) => (
                    <TableRow key={p.key}>
                      <TableCell className="font-medium">{p.label}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {p.executions}
                        <span className="text-muted-foreground"> ({p.buckets.reduce((s, b) => s + b.confirmed, 0)}✓)</span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {p.ewmaSlipPct != null ? `${p.ewmaSlipPct.toFixed(2)}%` : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {p.buckets.map((b, i) => {
                            const mean = bucketMeanEdge(b);
                            if (b.confirmed < DEFAULT_LEARNING_CONFIG.minSamplesBucket || mean == null) {
                              return null;
                            }
                            return (
                              <span
                                key={i}
                                title={`${SIZE_BUCKET_LABELS[i]}: ${b.confirmed} confirmed`}
                                className={cn(
                                  "rounded px-1.5 py-0.5 text-[10px] font-mono tabular-nums border",
                                  mean >= 0
                                    ? "border-leef/30 bg-leef/10 text-leef"
                                    : "border-sell/30 bg-sell/10 text-sell",
                                )}
                              >
                                {SIZE_BUCKET_LABELS[i]} {mean >= 0 ? "+" : ""}
                                {mean.toFixed(2)}%
                              </span>
                            );
                          })}
                          {p.buckets.every((b) => b.confirmed < DEFAULT_LEARNING_CONFIG.minSamplesBucket) && (
                            <span className="text-xs text-muted-foreground">
                              collecting (need ≥{DEFAULT_LEARNING_CONFIG.minSamplesBucket}/bucket)
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {p.gateFails}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <Card className="p-4 sm:p-5">
        <h3 className="font-semibold mb-1">Learning artifacts</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Typed, bounded adjustments proposed from evidence. Shadow = measured against new
          executions but not applied. Promotion requires the shadow error to beat the baseline over
          ≥{DEFAULT_LEARNING_CONFIG.shadowMinSamples} samples; rollback always reverts to the
          deterministic default.
        </p>
        {artifacts.length === 0 ? (
          <div className="rounded-lg border border-dashed py-10 px-8 text-center">
            <p className="text-muted-foreground max-w-md mx-auto text-sm">
              No artifacts yet. They appear once a pool crosses the sample floor (
              {DEFAULT_LEARNING_CONFIG.minSamplesSlippage}+ confirmed fills for slippage,{" "}
              {DEFAULT_LEARNING_CONFIG.minSamplesSizeCurve}+ for size curves).
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {artifacts.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card/50 px-3 py-2">
                <Badge
                  variant="outline"
                  className={cn(
                    a.status === "active" && "border-leef/40 text-leef",
                    a.status === "shadow" && "border-warn/40 text-warn",
                    (a.status === "rolled_back" || a.status === "expired" || a.status === "rejected") &&
                      "border-sell/40 text-sell",
                  )}
                >
                  {a.status}
                </Badge>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium font-mono truncate">{a.id}</div>
                  <div className="text-xs text-muted-foreground">
                    value {a.type === "POOL_SIZE_MULTIPLIER" ? `×${a.value.toFixed(2)}` : `${a.value.toFixed(2)}%`}
                    {" · "}default {a.type === "POOL_SIZE_MULTIPLIER" ? `×${a.previousValue.toFixed(2)}` : `${a.previousValue.toFixed(2)}%`}
                    {" · "}{a.samples} samples · conf {(a.confidence * 100).toFixed(0)}%
                    {" · "}shadow {a.shadow.n}
                    {" · "}expires {timeAgo(new Date(a.expiresAt).toISOString())}
                  </div>
                </div>
                {a.status === "shadow" && learningMode === "suggest" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const r = promoteArtifact(a.id);
                      toast({
                        title: r.ok ? "Artifact promoted" : "Promotion refused",
                        description: r.reason,
                        variant: r.ok ? "default" : "destructive",
                      });
                      setArtifacts(getArtifacts());
                    }}
                  >
                    Promote
                  </Button>
                )}
                {a.status === "active" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      rollbackArtifactById(a.id);
                      toast({ title: "Rolled back", description: `${a.id} reverted to the deterministic default` });
                      setArtifacts(getArtifacts());
                    }}
                  >
                    Roll back
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {replay && replay.summary.total > 0 && (
        <Card className="p-4 sm:p-5">
          <h3 className="font-semibold mb-1">Decision replay</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Today's router + gate math re-run against recorded route-scoped market fixtures.
            This is <span className="font-medium">decision-logic regression</span> — it proves
            whether a code change would have decided differently on the same book. It is NOT a
            P&amp;L backtest: the historical venue quote is gone; replay uses the recorded one.
          </p>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Identical", value: replay.summary.same, cls: "text-leef" },
              { label: "Verdict flipped", value: replay.summary.flipped, cls: "text-warn" },
              { label: "Route changed", value: replay.summary.routeChanged, cls: "text-accent" },
              { label: "Not replayable", value: replay.summary.notReplayable, cls: "text-muted-foreground" },
            ].map((c) => (
              <div key={c.label} className="rounded-lg border bg-card/50 p-3 text-center">
                <div className={cn("text-2xl font-semibold tabular-nums", c.cls)}>{c.value}</div>
                <div className="text-xs text-muted-foreground">{c.label}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            {replay.results.slice(0, 12).map((r, i) => {
              const fx = fixtures.find((f) => f.ts === r.ts);
              return (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border bg-card/50 px-3 py-2 text-xs">
                  <span className="text-muted-foreground tabular-nums">{timeAgo(new Date(r.ts).toISOString())}</span>
                  <Badge variant="outline">{fx?.kind === "gate_veto" ? "gate veto" : "execution"}</Badge>
                  <span className="font-mono">
                    {fx ? `${fx.tokenIn}→${fx.tokenOut} ${fmtNum(fx.amountIn, { compact: true })}` : "—"}
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    {r.thenPass != null && (
                      <span className={r.thenPass ? "text-leef" : "text-sell"}>
                        then {r.thenPass ? "PASS" : "FAIL"} {r.thenNetPct != null ? `(${r.thenNetPct.toFixed(2)}%)` : ""}
                      </span>
                    )}
                    {r.nowPass != null && (
                      <span className={r.nowPass ? "text-leef" : "text-sell"}>
                        now {r.nowPass ? "PASS" : "FAIL"} {r.nowNetPct != null ? `(${r.nowNetPct.toFixed(2)}%)` : ""}
                      </span>
                    )}
                    <Badge
                      variant="outline"
                      className={cn(
                        r.verdict === "same" && "border-leef/40 text-leef",
                        r.verdict === "flipped" && "border-warn/40 text-warn",
                        r.verdict === "route_changed" && "border-accent/40 text-accent",
                      )}
                    >
                      {r.verdict.replace("_", " ")}
                    </Badge>
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {stats && stats.topGateFails.length > 0 && (
        <Card className="p-4 sm:p-5">
          <h3 className="font-semibold mb-1">Why the exact-quote gate vetoes</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Grouped failure signatures. A high count here is the CP-discovery vs venue-CLMM
            disagreement rate — the number that decides whether tick-level discovery is worth
            building.
          </p>
          <div className="flex flex-col gap-2">
            {stats.topGateFails.map((f) => (
              <div key={f.reason} className="flex items-start justify-between gap-4 rounded-lg border bg-card/50 px-3 py-2">
                <code className="text-xs text-muted-foreground break-all">{f.reason}</code>
                <Badge variant="outline" className="shrink-0 tabular-nums">
                  {fmtNum(f.count, { digits: 0 })}
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
