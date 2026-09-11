import { useEffect, useRef } from "react";
import {
  holdingsFromBalances,
  planRebalance,
  quoteLegs,
  type PlannedLeg,
} from "@/lib/leef/rebalance";
import { fmtUsd } from "@/lib/leef/format";
import type { LeefSnapshot } from "@/lib/leef/types";
import { signAndPushBatch, type BatchLeg } from "@/lib/wallet/sign";
import { usePortfolio } from "@/store/portfolio";
import { useWallet } from "@/store/wallet";
import { toast } from "@/hooks/useToast";

let sweeping = false;

/**
 * Run one rebalance cycle: value holdings → plan dust sweeps + drift repair
 * → quote every leg on Alcor's router → execute (paper: simulated fills;
 * live: all legs batched into ONE atomic WAX transaction).
 */
export async function runRebalancer(snap: LeefSnapshot, opts?: { force?: boolean }) {
  if (sweeping) return;
  sweeping = true;
  try {
    const p = usePortfolio.getState();
    const w = useWallet.getState();
    const mode: "paper" | "live" = w.canSign() ? "live" : "paper";

    if (!p.running && !opts?.force) return;
    if (snap.source !== "live") {
      p.setLastPlanNote("Book is stale — waiting for live Alcor data");
      return;
    }
    if (snap.universe.length === 0) {
      p.setLastPlanNote("Token universe not loaded yet");
      return;
    }

    const balances = w.balances();
    const { holdings, unknown } = holdingsFromBalances(balances, snap.universe);
    if (holdings.length === 0) {
      p.setLastPlanNote("No priced holdings found in this wallet");
      return;
    }

    const plan = planRebalance({
      holdings,
      ladder: p.ladder,
      universe: snap.universe,
      settings: p.settings,
      balances,
    });
    if (unknown.length > 0) {
      plan.notes.push(`Unpriced (no liquid pool): ${unknown.slice(0, 5).join(", ")}`);
    }

    if (plan.legs.length === 0) {
      p.markRun();
      p.setLastPlanNote(plan.notes[0] ?? "Balanced");
      return;
    }

    const account = mode === "live" ? w.account : "paper.leef";
    const quoted = await quoteLegs(plan.legs, account, p.settings.slippage, p.settings.maxImpactPct);
    const ready = quoted.filter((l) => l.quote);
    const dropped = quoted.filter((l) => !l.quote);
    for (const d of dropped) {
      p.pushLog({
        mode,
        status: "skipped",
        summary: `${d.from.symbol} → ${d.to.symbol} skipped`,
        legs: [d.reason, d.quoteError ?? "No route"],
        totalUsd: d.estUsd,
      });
    }
    if (ready.length === 0) {
      p.markRun();
      p.setLastPlanNote("Planned legs had no route this cycle");
      return;
    }

    const legSummary = (l: PlannedLeg) =>
      `${fmtCompact(l.amountIn)} ${l.from.symbol} → ${l.quote!.output} ${l.to.symbol} (${
        l.quote!.swaps.length > 1 ? `${l.quote!.swaps.length} split · ` : ""
      }route [${l.quote!.route.join(",")}])`;

    if (mode === "paper") {
      for (const leg of ready) {
        const out = Number(leg.quote!.output) || 0;
        w.applyPaperFill(leg.from.symbol, leg.amountIn, leg.to.symbol, out);
      }
      const totalUsd = ready.reduce((s, l) => s + l.estUsd, 0);
      p.markRun();
      p.addTotals(
        ready.filter((l) => l.kind === "dust").reduce((s, l) => s + l.estUsd, 0),
        totalUsd,
      );
      p.pushLog({
        mode,
        status: "filled",
        summary: `Paper sweep · ${ready.length} leg${ready.length === 1 ? "" : "s"} · ${fmtUsd(totalUsd, 2)}`,
        legs: ready.map(legSummary),
        totalUsd,
      });
      p.setLastPlanNote(`Swept ${ready.length} leg${ready.length === 1 ? "" : "s"} (paper)`);
      toast({ title: `Paper sweep · ${ready.length} legs`, description: legSummary(ready[0]!) });
      return;
    }

    // Live: one atomic transaction with every leg's transfers inside.
    const batchLegs: BatchLeg[] = ready.flatMap((leg) =>
      leg.quote!.swaps.map((s) => ({
        contract: leg.from.contract,
        quantity: s.input,
        memo: s.memo,
      })),
    );
    try {
      const { txid } = await signAndPushBatch({
        account: w.account,
        permission: w.permission,
        legs: batchLegs,
      });
      const totalUsd = ready.reduce((s, l) => s + l.estUsd, 0);
      p.markRun();
      p.addTotals(
        ready.filter((l) => l.kind === "dust").reduce((s, l) => s + l.estUsd, 0),
        totalUsd,
      );
      p.pushLog({
        mode,
        status: "filled",
        summary: `Live sweep · ${ready.length} leg${ready.length === 1 ? "" : "s"} · ${fmtUsd(totalUsd, 2)}`,
        legs: ready.map(legSummary),
        totalUsd,
        txid,
      });
      p.setLastPlanNote(`Swept ${ready.length} legs on-chain`);
      toast({
        title: `Sweep broadcast ${txid.slice(0, 8)}…`,
        description: `${ready.length} legs in one atomic WAX transaction`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Broadcast failed";
      p.markRun();
      p.pushLog({
        mode,
        status: "failed",
        summary: "Atomic sweep reverted",
        legs: [msg, ...ready.map(legSummary)],
        totalUsd: ready.reduce((s, l) => s + l.estUsd, 0),
      });
      p.setLastPlanNote(msg);
      toast({ title: "Sweep failed", description: msg, variant: "destructive" });
    }
  } finally {
    sweeping = false;
  }
}

function fmtCompact(n: number): string {
  return n >= 1000
    ? n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 2 })
    : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/** Interval driver — evaluates the book and fires the rebalancer when due. */
export function usePortfolioLoop(snap: LeefSnapshot) {
  const fetchedAt = snap.fetchedAt;
  const running = usePortfolio((s) => s.running);
  const prevRunning = useRef(false);
  const lastSnap = useRef("");

  useEffect(() => {
    const justStarted = running && !prevRunning.current;
    prevRunning.current = running;
    const isNewSnap = lastSnap.current !== fetchedAt;
    if (isNewSnap) lastSnap.current = fetchedAt;

    const p = usePortfolio.getState();
    if (!p.running) return;
    const due = Date.now() - p.lastRunAt >= p.settings.intervalSec * 1000;
    if (!due && !justStarted) return;
    if (!isNewSnap && !justStarted) return;
    void runRebalancer(snap);
  }, [fetchedAt, running, snap]);
}
