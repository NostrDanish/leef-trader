import { useCallback, useEffect, useState } from "react";
import { Download, FlaskConical, Loader2, RefreshCw, Trash2 } from "lucide-react";
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
  journalClear,
  journalExportBlob,
  journalStats,
  MAX_ENTRIES,
  type EvidenceStats,
} from "@/lib/leef/journal";
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
  const [stats, setStats] = useState<EvidenceStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStats(await journalStats());
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
                before clearing site data.
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
              sub: "exact-quote gate",
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
