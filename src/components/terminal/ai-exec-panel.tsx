import { useState } from "react";
import { BrainCircuit, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  AI_EXEC_CONFIDENCE_MIN,
  AI_QID,
  type AiAction,
  type AiProposal,
} from "@/lib/leef/ai-executor";
import { relTime, useNow } from "./use-now";
import type { LeefSnapshot } from "@/lib/leef/types";
import { cn } from "@/lib/utils";
import { useTerminal } from "@/store/terminal";
import { useBot } from "@/store/bot";
import { useWallet } from "@/store/wallet";

/** Proposal freshness must match the bot loop's execution gate exactly. */
const PROPOSAL_TTL_MS = 60_000;

const ACTION_LABEL: Record<AiAction, string> = {
  hold: "Hold",
  buy: "Buy",
  sell: "Sell",
  swap: "Swap",
  rebalance: "Rebalance",
  reduce_risk: "Reduce risk",
  cancel_all: "Cancel all",
};

function describeProposal(p: AiProposal): string {
  switch (p.action) {
    case "hold":
      return "Do nothing this cycle.";
    case "buy":
      return `Enter/add a position using ${p.params.sizePct ?? "?"}% of the deployable quote.`;
    case "sell":
    case "reduce_risk":
      return `Exit ${p.params.sizePct ?? "?"}% of the open position.`;
    case "swap":
      return `Swap ${p.params.sizePct ?? "?"}% of ${p.params.tokenIn ?? "?"} → ${p.params.tokenOut ?? "?"}.`;
    case "rebalance":
      return "Move value toward a balanced portfolio (rebalancer executes).";
    case "cancel_all":
      return "Sit flat this cycle.";
  }
}

/**
 * Jev execution panel (S4). The execution authority switch — OFF / SUGGEST /
 * CONTROL — plus the live proposal card with per-judgment confidences.
 * In SUGGEST the proposal is advisory; in CONTROL the bot loop itself picks
 * it up through the unchanged risk gauntlet. This panel executes NOTHING.
 */
export function AiExecPanel({ snap }: { snap: LeefSnapshot }) {
  const aiControl = useTerminal((s) => s.aiControl);
  const setAiControl = useTerminal((s) => s.setAiControl);
  const proposal = useTerminal((s) => s.aiProposal);
  const running = useBot((s) => s.running);
  const mode = useWallet((s) => s.mode);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const now = useNow(5000);

  const fresh = proposal != null && now - proposal.fetchedAt < PROPOSAL_TTL_MS;
  const executable =
    proposal != null && fresh && proposal.confidence >= AI_EXEC_CONFIDENCE_MIN;

  const applyMode = (m: "off" | "suggest" | "control") => {
    if (m === "control") {
      setConfirmOpen(true);
      return;
    }
    setAiControl(m);
  };

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-leef/10 p-2 text-leef">
            <BrainCircuit className="size-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Jev execution</h2>
            <p className="max-w-prose text-sm text-muted-foreground">
              The Jev model (TypeSafe System One) reads a code-built market
              summary and answers typed questions — the action, its arguments,
              and two risk nouls. Code stays in charge: a proposal executes
              only through the unchanged deterministic risk gauntlet, and only
              in CONTROL mode.
            </p>
          </div>
        </div>
        <div
          className="flex overflow-hidden rounded-lg border border-border"
          role="radiogroup"
          aria-label="Jev execution authority"
        >
          {(
            [
              ["off", "OFF"],
              ["suggest", "SUGGEST"],
              ["control", "CONTROL"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={aiControl === m}
              onClick={() => applyMode(m)}
              className={cn(
                "px-3 py-1.5 text-xs transition-colors",
                aiControl === m
                  ? m === "control"
                    ? "bg-sell/15 text-sell"
                    : "bg-accent/15 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {aiControl === "control" && (
        <div
          className={cn(
            "mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
            running
              ? "border-sell/30 bg-sell/10 text-sell"
              : "border-warn/30 bg-warn/10 text-warn",
          )}
        >
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          {running
            ? mode === "live"
              ? "LIVE CONTROL — Jev proposals at/above the confidence floor execute with real funds through the normal risk gauntlet."
              : "Paper control — proposals execute against the paper wallet."
            : "Control armed — proposals execute once the bot is running. Start the engine on the Bot desk."}
        </div>
      )}

      <div className="mt-4">
        {proposal == null ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            {aiControl === "off"
              ? "Jev is OFF — zero calls leave this browser."
              : "No proposal yet — the bot loop asks Jev once per cycle while it runs."}
          </p>
        ) : (
          <div className="rounded-lg border border-border bg-background p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge variant={proposal.action === "hold" ? "plain" : "accent"}>
                  {ACTION_LABEL[proposal.action]}
                </Badge>
                <Badge
                  variant="outline"
                  className={cn(
                    "font-mono tabular-nums",
                    executable
                      ? "border-leef/40 text-leef"
                      : "border-warn/40 text-warn",
                  )}
                >
                  weakest {(proposal.confidence * 100).toFixed(0)}%
                  {executable
                    ? " ≥ floor"
                    : ` < ${(AI_EXEC_CONFIDENCE_MIN * 100).toFixed(0)}% floor`}
                </Badge>
                {!fresh && <Badge variant="warn">stale</Badge>}
              </div>
              <span className="font-mono text-xs text-subtle">
                {relTime(proposal.fetchedAt, now)}
              </span>
            </div>
            <p className="mt-2 text-sm">{describeProposal(proposal)}</p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {proposal.rationale}
            </p>

            <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {(
                [
                  [AI_QID.action, "action"],
                  [AI_QID.sizeBucket, "size"],
                  [AI_QID.swapTokenIn, "token in"],
                  [AI_QID.swapTokenOut, "token out"],
                  [AI_QID.riskStress, "stress"],
                  [AI_QID.riskExecute, "data ok"],
                ] as const
              ).map(([qid, label]) => {
                const a = proposal.answers[qid];
                if (!a) return null;
                const conf =
                  a.type === "noul" && typeof a.noul === "number"
                    ? Math.abs(a.noul - 0.5) * 2
                    : typeof a.confidence === "number"
                      ? a.confidence
                      : null;
                const verdict =
                  a.type === "noul" && typeof a.noul === "number"
                    ? a.noul >= 0.5
                      ? "yes"
                      : "no"
                    : (a.choice ?? "—");
                const weakest = proposal.weakest === qid;
                return (
                  <div
                    key={qid}
                    className={cn(
                      "rounded-md border px-2 py-1.5 font-mono text-[11px]",
                      weakest
                        ? "border-warn/50 bg-warn/5"
                        : "border-border bg-surface",
                    )}
                    title={weakest ? "Weakest judgment — sets the proposal confidence" : undefined}
                  >
                    <div className="text-subtle">
                      {label}
                      {weakest ? " · weakest" : ""}
                    </div>
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate text-foreground">{verdict}</span>
                      <span
                        className={cn(
                          "tabular-nums",
                          conf != null && conf >= AI_EXEC_CONFIDENCE_MIN
                            ? "text-leef"
                            : "text-warn",
                        )}
                      >
                        {conf != null ? `${(conf * 100).toFixed(0)}%` : "—"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="mt-3 flex items-center gap-1.5 text-[11px] text-subtle">
              {executable ? (
                <ShieldCheck className="size-3 text-leef" />
              ) : (
                <ShieldAlert className="size-3 text-warn" />
              )}
              {aiControl === "control"
                ? executable
                  ? running
                    ? "Execution candidate — the risk gauntlet still decides."
                    : "Would execute once the engine is running."
                  : "Below the confidence floor — advisory only, never executed."
                : "Advisory only — switch to CONTROL to let it trade."}
            </p>
          </div>
        )}
      </div>

      <p className="mt-3 text-[11px] text-subtle">
        Book {snap.source === "live" ? "live" : "cached"} · Jev never sees keys,
        never signs, and the TypeSafe key stays on the server (/api/jev).
      </p>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Let Jev trade?</AlertDialogTitle>
            <AlertDialogDescription>
              In CONTROL mode a fresh Jev proposal whose weakest judgment is at
              least {(AI_EXEC_CONFIDENCE_MIN * 100).toFixed(0)}% confident
              becomes an execution candidate and runs through the normal risk
              gauntlet — with real funds when the wallet is live. The bot must
              be running. You can revoke this at any time by switching back to
              SUGGEST or OFF.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setAiControl("control", true);
                setConfirmOpen(false);
              }}
            >
              Grant control
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// Kept for the loop: the exact freshness rule, single source of truth here.
export const AI_PROPOSAL_TTL_MS = PROPOSAL_TTL_MS;
