import {
  chunkSweepLegs,
  holdingsFromBalances,
  planRebalance,
  quoteLegs,
  quoteOracleDeviationPct,
  type PlannedLeg,
} from "@/lib/leef/rebalance";
import { fmtUsd } from "@/lib/leef/format";
import { journal } from "@/lib/leef/journal";
import type { LeefSnapshot } from "@/lib/leef/types";
import { parseAssetAmount } from "@/lib/wallet/alcor-route";
import { waxResourceBlock } from "@/lib/wallet/chain";
import { signAndPushBatch, type BatchLeg } from "@/lib/wallet/sign";
import {
  capitalAvailable,
  coordinateCapitalMovement,
} from "@/lib/wallet/execution-coordinator";
import { syncWalletBalances } from "./use-wallet-sync";
import { useBot } from "@/store/bot";
import { usePortfolio } from "@/store/portfolio";
import { useWallet } from "@/store/wallet";
import { toast } from "@/hooks/useToast";

let sweeping = false;
/**
 * CPU/failure-throttle cooldown. A reverted sweep (tx_cpu_usage_exceeded)
 * also eats into the account's producer-side failure budget — hammering
 * retries gets the account throttled. On such a failure, pause automatic
 * sweeps until this time (parsed from the chain's "until" hint when present).
 */
let sweepCooldownUntil = 0;

const CPU_FAILURE_RE = /cpu|failure limit|tx_cpu_usage/i;

function noteSweepCooldown(msg: string): number {
  const m = /until\s+(\d{4}-\d{2}-\d{2}T[\d:.]+)/.exec(msg);
  const parsed = m ? Date.parse(`${m[1]}Z`) : NaN;
  // Chain failure windows are short; the real risk is re-packing the same
  // oversized tx next cycle. Hold a 15-minute floor.
  const until = Math.max(Date.now() + 15 * 60_000, Number.isFinite(parsed) ? parsed + 5_000 : 0);
  sweepCooldownUntil = until;
  return until;
}

/** Cooldown remaining, seconds (0 when sweeps may run). */
export function sweepCooldownSec(): number {
  return Math.max(0, Math.ceil((sweepCooldownUntil - Date.now()) / 1000));
}

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
    const { holdings, unknown } = holdingsFromBalances(balances, snap.universe, snap.spotAt ?? snap.fetchedAt);
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

    // Opportunity dedup: while the bot is managing an open LEEF position, the
    // rebalancer must not sell LEEF out from under it — same wallet, same
    // market event. LEEF-selling legs wait for a flat bot.
    const bot = useBot.getState();
    const botHoldsLeef = bot.running && !!bot.position && bot.position.amountLeef > 0;
    const legs = botHoldsLeef
      ? plan.legs.filter((l) => l.from.symbol !== "LEEF")
      : plan.legs;
    if (legs.length < plan.legs.length) {
      p.pushLog({
        mode,
        status: "skipped",
        summary: "LEEF legs deferred — bot holds an open LEEF position",
        legs: plan.legs.filter((l) => l.from.symbol === "LEEF").map((l) => l.reason),
        totalUsd: 0,
      });
      if (legs.length === 0) {
        p.markRun();
        p.setLastPlanNote("All legs deferred — bot holds an open LEEF position");
        return;
      }
    }

    const account = mode === "live" ? w.account : "paper.leef";
    const quoted = await quoteLegs(legs, account, p.settings.slippage, p.settings.maxImpactPct);
    const quotedOk = quoted.filter((l) => l.quote);
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

    // Poisoned-pool guard: a rebalancer consolidates at FAIR VALUE — it is
    // not an arb desk. If the venue's own executable quote implies a price
    // far from the oracle in either direction, the pool is broken or bait:
    // refuse the leg rather than sign a fantasy quote into an atomic tx.
    const devCap = p.settings.maxOracleDeviationPct ?? 35;
    const ready: PlannedLeg[] = [];
    for (const leg of quotedOk) {
      const dev = quoteOracleDeviationPct(leg);
      if (dev != null && Math.abs(dev) > devCap) {
        p.pushLog({
          mode,
          status: "skipped",
          summary: `${leg.from.symbol} → ${leg.to.symbol} refused`,
          legs: [
            leg.reason,
            `Venue quote implies ${dev > 0 ? "+" : ""}${dev.toFixed(1)}% vs oracle — outside ±${devCap}% (poisoned-pool protection)`,
          ],
          totalUsd: leg.estUsd,
        });
        continue;
      }
      ready.push(leg);
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
      const filled: PlannedLeg[] = [];
      for (const leg of ready) {
        const out = parseAssetAmount(leg.quote!.output);
        if (!(out > 0)) {
          p.pushLog({
            mode,
            status: "skipped",
            summary: `${leg.from.symbol} → ${leg.to.symbol} skipped`,
            legs: [leg.reason, `Unparseable quote output "${leg.quote!.output}"`],
            totalUsd: leg.estUsd,
          });
          continue;
        }
        w.applyPaperFill(leg.from.symbol, leg.amountIn, leg.to.symbol, out);
        filled.push(leg);
      }
      if (filled.length === 0) {
        p.markRun();
        p.setLastPlanNote("Paper quotes had no parseable output");
        return;
      }
      const totalUsd = filled.reduce((s, l) => s + l.estUsd, 0);
      p.markRun();
      p.addTotals(
        filled.filter((l) => l.kind === "dust").reduce((s, l) => s + l.estUsd, 0),
        totalUsd,
      );
      p.pushLog({
        mode,
        status: "filled",
        summary: `Paper sweep · ${filled.length} leg${filled.length === 1 ? "" : "s"} · ${fmtUsd(totalUsd, 2)}`,
        legs: filled.map(legSummary),
        totalUsd,
      });
      p.setLastPlanNote(`Swept ${filled.length} leg${filled.length === 1 ? "" : "s"} (paper)`);
      toast({ title: `Paper sweep · ${filled.length} legs`, description: legSummary(filled[0]!) });
      return;
    }

    const resBlock = waxResourceBlock(w.cpuPct, w.netPct, w.ramPct);
    if (resBlock) {
      p.markRun();
      p.setLastPlanNote(resBlock);
      p.pushLog({
        mode,
        status: "skipped",
        summary: resBlock,
        legs: ready.map(legSummary),
        totalUsd: ready.reduce((s, l) => s + l.estUsd, 0),
      });
      return;
    }

    // Live: chunked transactions. WAX enforces a per-tx CPU budget and CLMM
    // swaps are CPU-heavy — one atomic mega-sweep reverts with
    // tx_cpu_usage_exceeded, and repeated reverts get the ACCOUNT throttled.
    // Pack legs into ≤ MAX_ACTIONS_PER_SWEEP_TX-action transactions, execute
    // sequentially, and STOP on the first failure/unknown instead of
    // compounding the throttle.
    const { chunks, dropped: tooComplex } = chunkSweepLegs(ready);
    for (const d of tooComplex) {
      p.pushLog({
        mode,
        status: "skipped",
        summary: `${d.from.symbol} → ${d.to.symbol} skipped`,
        legs: [
          d.reason,
          `Route expands to ${d.quote?.swaps.length ?? "?"} on-chain actions — too complex for a single transaction`,
        ],
        totalUsd: d.estUsd,
      });
    }
    if (chunks.length === 0) {
      p.markRun();
      p.setLastPlanNote("Every quoted leg was too complex to fit a transaction");
      return;
    }

    let confirmedLegs = 0;
    let confirmedUsd = 0;
    let dustUsd = 0;
    let lastTxid: string | undefined;
    let halted: string | null = null;
    const t0 = Date.now();

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci]!;
      const chunkUsd = chunk.reduce((s, l) => s + l.estUsd, 0);
      // Each plan leg spends inventory the wallet held before this cycle;
      // amounts were reserved by planRebalance. Router splits stay inside
      // their leg, so chunking never splits a leg across transactions.
      const batchLegs: BatchLeg[] = chunk.flatMap((leg) =>
        leg.quote!.swaps.map((s) => ({
          contract: leg.from.contract,
          quantity: s.input,
          memo: s.memo,
        })),
      );
      const tag = chunks.length > 1 ? `chunk ${ci + 1}/${chunks.length} · ` : "";
      try {
        const coordinated = await coordinateCapitalMovement({
          owner: "rebalancer",
          submit: () =>
            signAndPushBatch({
              account: w.account,
              permission: w.permission,
              legs: batchLegs,
              snap,
            }),
          onSettled: async (result) => {
            if (result.status === "confirmed") await syncWalletBalances(snap);
          },
        });
        const { txid, reconciliation } = coordinated;
        lastTxid = txid;
        journal({
          kind: "execution", action: "rebalance", mode,
          reason:
            reconciliation.status === "failed"
              ? `${tag}reverted · ${reconciliation.error}`
              : `${tag}${chunk.length} leg${chunk.length === 1 ? "" : "s"} · ${fmtUsd(chunkUsd, 2)}`,
          status: reconciliation.status === "confirmed" ? "confirmed" : reconciliation.status === "failed" ? undefined : "unknown",
          txid, latencyMs: Date.now() - t0, waxUsd: snap.waxUsd, leefUsd: snap.leefUsd,
        });
        if (reconciliation.status === "failed") {
          halted = reconciliation.error;
          if (CPU_FAILURE_RE.test(reconciliation.error)) noteSweepCooldown(reconciliation.error);
          p.pushLog({
            mode,
            status: "failed",
            summary: `Sweep ${tag}reverted${chunks.length > ci + 1 ? " — remaining chunks skipped" : ""}`,
            legs: [reconciliation.error, ...chunk.map(legSummary)],
            totalUsd: chunkUsd,
            txid,
          });
          break;
        }
        if (reconciliation.status === "confirmed") {
          confirmedLegs += chunk.length;
          confirmedUsd += chunkUsd;
          dustUsd += chunk.filter((l) => l.kind === "dust").reduce((s, l) => s + l.estUsd, 0);
          p.pushLog({
            mode,
            status: "filled",
            summary: `Live sweep ${tag}confirmed · ${chunk.length} leg${chunk.length === 1 ? "" : "s"} · ${fmtUsd(chunkUsd, 2)}`,
            legs: chunk.map(legSummary),
            totalUsd: chunkUsd,
            txid,
          });
          continue;
        }
        // UNKNOWN — capital may be locked; never stack another chunk on top.
        halted = `Transaction ${txid.slice(0, 10)}… pending — capital locked, remaining chunks skipped`;
        p.pushLog({
          mode,
          status: "planned",
          summary: `Sweep ${tag}broadcast · confirmation UNKNOWN — capital locked`,
          legs: chunk.map(legSummary),
          totalUsd: chunkUsd,
          txid,
        });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Broadcast failed";
        halted = msg;
        if (CPU_FAILURE_RE.test(msg)) noteSweepCooldown(msg);
        journal({
          kind: "execution", action: "rebalance", mode,
          reason: `${tag}failed · ${msg}`,
          latencyMs: Date.now() - t0, waxUsd: snap.waxUsd, leefUsd: snap.leefUsd,
        });
        p.pushLog({
          mode,
          status: "failed",
          summary: `Sweep ${tag}failed${chunks.length > ci + 1 ? " — remaining chunks skipped" : ""}`,
          legs: [msg, ...chunk.map(legSummary)],
          totalUsd: chunkUsd,
        });
        break;
      }
    }

    p.markRun();
    if (confirmedLegs > 0) p.addTotals(dustUsd, confirmedUsd);
    const totalUsd = ready.reduce((s, l) => s + l.estUsd, 0);
    if (halted) {
      p.setLastPlanNote(halted);
      toast({
        title: "Sweep halted",
        description: confirmedLegs > 0 ? `${confirmedLegs} leg${confirmedLegs === 1 ? "" : "s"} confirmed, then: ${halted}` : halted,
        variant: "destructive",
      });
    } else {
      p.setLastPlanNote(`Swept ${confirmedLegs} legs · confirmed on-chain`);
      toast({
        title: `Sweep confirmed ${lastTxid ? `${lastTxid.slice(0, 8)}…` : ""}`,
        description: `${confirmedLegs} legs reconciled on WAX${chunks.length > 1 ? ` in ${chunks.length} transactions` : ""} · ${fmtUsd(totalUsd, 2)}`,
      });
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

let lastSeenSnap = "";
let prevRunning = false;

/**
 * Per-snapshot rebalancer driver (plain function — called by the MarketEngine,
 * not by a React effect). Evaluates the book and fires the rebalancer when due.
 */
export function rebalancerOnSnapshot(snap: LeefSnapshot): void {
  const running = usePortfolio.getState().running;
  const justStarted = running && !prevRunning;
  prevRunning = running;

  const identity = `${snap.fetchedAt}|${snap.spotAt ?? ""}`;
  const isNewSnap = lastSeenSnap !== identity;
  if (isNewSnap) lastSeenSnap = identity;

  const p = usePortfolio.getState();
  if (!p.running) return;
  const cooldownSec = sweepCooldownSec();
  if (cooldownSec > 0) {
    p.setLastPlanNote(
      `Sweep cooldown after a CPU revert — ${Math.ceil(cooldownSec / 60)}m left (manual rebalance from the desk still works)`,
    );
    return;
  }
  if (!capitalAvailable()) {
    p.setLastPlanNote("Waiting — another trade owns the capital lane");
    return;
  }
  const due = Date.now() - p.lastRunAt >= p.settings.intervalSec * 1000;
  if (!due && !justStarted) return;
  if (!isNewSnap && !justStarted) return;
  void runRebalancer(snap);
}
