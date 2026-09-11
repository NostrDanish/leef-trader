import { useEffect, useRef } from "react";
import { evaluateBot, type Position } from "@/lib/leef/bot-engine";
import { fmtNum } from "@/lib/leef/format";
import type { LeefSnapshot } from "@/lib/leef/types";
import { signAndPushArb, signAndPushSwap } from "@/lib/wallet/sign";
import { useBot } from "@/store/bot";
import { useWallet } from "@/store/wallet";
import { toast } from "@/hooks/useToast";

function equityUsdOf(balances: Record<string, number>, snap: LeefSnapshot): number {
  return (
    (balances.WAX ?? 0) * snap.waxUsd + (balances.LEEF ?? 0) * snap.leefUsd
  );
}

let lastHoldReason = "";
let holdStreak = 0;
let executing = false;

/**
 * Evaluate the bot once against a snapshot. Exported so the desk can
 * dry-run ("what would it do now?") and force manual clips.
 * Executing calls are guarded — only one trade can be in flight at a time.
 */
export async function runBotOnce(
  snap: LeefSnapshot,
  opts?: { force?: "buy" | "sell"; dry?: boolean },
) {
  if (executing && !opts?.dry) return null;
  if (!opts?.dry) executing = true;
  try {
    return await runBotOnceInner(snap, opts);
  } finally {
    if (!opts?.dry) executing = false;
  }
}

async function runBotOnceInner(
  snap: LeefSnapshot,
  opts?: { force?: "buy" | "sell"; dry?: boolean },
) {
  const b = useBot.getState();
  const w = useWallet.getState();
  const balances = w.balances();
  const equityUsd = equityUsdOf(balances, snap);

  let decision = evaluateBot({
    now: Date.now(),
    snap,
    series: b.series,
    running: b.running,
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
    force: opts?.force ?? null,
  });

  const live = w.canSign();
  const mode: "paper" | "live" = live ? "live" : "paper";

  // A position opened live can't be managed in paper mode (and vice versa).
  if (
    b.position &&
    (decision.kind === "buy" || decision.kind === "sell") &&
    b.position.mode !== mode
  ) {
    decision = {
      kind: "hold",
      reason: `Position was opened in ${b.position.mode} mode — ${
        b.position.mode === "live" ? "re-import the key to manage it" : "forget the live key first"
      }`,
    };
  }

  b.setLastReason(decision.reason);

  if (decision.kind === "hold") {
    holdStreak += 1;
    if (decision.reason !== lastHoldReason || holdStreak % 10 === 0) {
      b.pushDecision({ kind: "hold", mode, reason: decision.reason, priceUsd: snap.leefUsd });
    }
    lastHoldReason = decision.reason;
    return decision;
  }
  holdStreak = 0;
  lastHoldReason = "";

  if (decision.kind === "stop") {
    b.pushDecision({ kind: "stop", mode, reason: decision.reason, priceUsd: snap.leefUsd });
    b.stop(decision.reason);
    toast({ title: "Bot stopped", description: decision.reason });
    return decision;
  }

  if (opts?.dry) return decision;

  try {
    if (decision.kind === "buy") {
      const minOut = decision.route.amountOut * (1 - b.risk.slippage / 100);
      let amountLeef = minOut;
      let txid: string | undefined;
      if (live) {
        const exec = await signAndPushSwap({
          account: w.account,
          permission: w.permission,
          route: decision.route,
          amountIn: decision.amountWax,
          slippagePct: b.risk.slippage,
          snap,
        });
        txid = exec.txid;
        amountLeef = exec.expectedOut > 0 ? exec.expectedOut : minOut;
      } else {
        w.applyPaperFill("WAX", decision.amountWax, "LEEF", amountLeef);
      }
      // Average into an existing position (DCA) or open a fresh one.
      const prev = b.position;
      const position: Position = prev
        ? {
            amountLeef: prev.amountLeef + amountLeef,
            entryUsd:
              (prev.entryCostUsd + decision.amountWax * snap.waxUsd) /
              Math.max(prev.amountLeef + amountLeef, 1e-9),
            entryCostUsd: prev.entryCostUsd + decision.amountWax * snap.waxUsd,
            entryWax: prev.entryWax + decision.amountWax,
            since: prev.since,
            highUsd: Math.max(prev.highUsd, snap.leefUsd),
            mode,
          }
        : {
            amountLeef,
            entryUsd: snap.leefUsd,
            entryCostUsd: decision.amountWax * snap.waxUsd,
            entryWax: decision.amountWax,
            since: Date.now(),
            highUsd: snap.leefUsd,
            mode,
          };
      b.setPosition(position);
      b.setGridAnchor(snap.leefUsd);
      b.markTrade(b.risk.cooldownSec);
      b.pushDecision({
        kind: "buy",
        mode,
        reason: decision.reason,
        priceUsd: snap.leefUsd,
        txid,
      });
      toast({
        title: `${live ? "Live" : "Paper"} buy · ${fmtNum(amountLeef, { compact: true })} LEEF`,
        description: decision.reason + (txid ? ` · tx ${txid.slice(0, 10)}…` : ""),
      });
      return decision;
    }

    if (decision.kind === "sell") {
      const position = b.position;
      const waxOut = decision.route.amountOut;
      let txid: string | undefined;
      if (live) {
        const exec = await signAndPushSwap({
          account: w.account,
          permission: w.permission,
          route: decision.route,
          amountIn: decision.amountLeef,
          slippagePct: b.risk.slippage,
          snap,
        });
        txid = exec.txid;
      } else {
        w.applyPaperFill("LEEF", decision.amountLeef, "WAX", waxOut);
      }
      const pnlUsd = position ? waxOut * snap.waxUsd - position.entryCostUsd : 0;
      b.setPosition(null);
      b.setGridAnchor(snap.leefUsd);
      b.markTrade(b.risk.cooldownSec);
      b.recordResult(pnlUsd, equityUsd + pnlUsd);
      b.pushDecision({
        kind: "sell",
        mode,
        reason: decision.reason,
        priceUsd: snap.leefUsd,
        txid,
        pnlUsd,
      });
      toast({
        title: `${live ? "Live" : "Paper"} sell · ${fmtNum(waxOut, { digits: 2 })} WAX · ${
          pnlUsd >= 0 ? "+" : ""
        }$${pnlUsd.toFixed(2)}`,
        description: decision.reason + (txid ? ` · tx ${txid.slice(0, 10)}…` : ""),
        variant: pnlUsd < 0 ? "destructive" : "default",
      });
      return decision;
    }

    if (decision.kind === "arb") {
      const plan = decision.plan;
      let txid: string | undefined;
      if (live) {
        const res = await signAndPushArb({
          account: w.account,
          permission: w.permission,
          plan,
          // Volume echoes enforce the loss budget (negative floor); spread
          // arbs enforce the profit floor.
          minProfitPct:
            b.strategy === "volume" ? -b.risk.maxEchoLossPct : b.risk.minEdgePct,
          slippagePct: b.risk.slippage,
          snap,
        });
        txid = res.txid;
      } else {
        // Same symbol in and out — the fill nets the profit onto the balance.
        w.applyPaperFill("WAX", plan.waxIn, "WAX", plan.waxOut);
      }
      const pnlUsd = (plan.waxOut - plan.waxIn) * snap.waxUsd;
      b.markTrade(b.risk.cooldownSec);
      b.recordResult(pnlUsd, equityUsd + pnlUsd);
      if (b.strategy === "volume") {
        b.recordVolume((plan.waxIn + plan.waxOut) * snap.waxUsd, -pnlUsd);
      }
      b.pushDecision({
        kind: "arb",
        mode,
        reason: decision.reason,
        priceUsd: snap.leefUsd,
        txid,
        pnlUsd,
      });
      const diff = plan.waxOut - plan.waxIn;
      toast({
        title: `${live ? "Live" : "Paper"} ${b.strategy === "volume" ? "echo" : "arb"} · ${
          diff >= 0 ? "+" : ""
        }${fmtNum(diff, { digits: 3 })} WAX`,
        description: decision.reason + (txid ? ` · tx ${txid.slice(0, 10)}…` : ""),
      });
      return decision;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Trade failed";
    b.pushDecision({ kind: "error", mode, reason: msg, priceUsd: snap.leefUsd });
    b.setLastReason(msg);
    toast({ title: "Trade failed", description: msg, variant: "destructive" });
    return decision;
  }
  return decision;
}

/**
 * Seed the price series from real recent WAX-pool fills so the engines
 * warm up in the first minutes instead of after 17 minutes of polling.
 */
function seedSeriesFromTape(snap: LeefSnapshot) {
  const b = useBot.getState();
  if (b.series.length >= 10 || snap.source !== "live" || !(snap.waxUsd > 0)) return;
  const mainWaxId = [...snap.pools]
    .filter((p) => p.pair.symbol.toUpperCase() === "WAX")
    .sort((a, b2) => b2.tvlUsd - a.tvlUsd)[0]?.id;
  const points = snap.trades
    .filter((t) => t.poolId === mainWaxId && t.priceWax > 0)
    .map((t) => ({ t: t.timestamp, usd: t.priceWax * snap.waxUsd }))
    .sort((a, b2) => a.t - b2.t);
  const spaced: { t: number; usd: number }[] = [];
  for (const p of points) {
    const last = spaced[spaced.length - 1];
    if (!last || p.t - last.t > 20_000) spaced.push(p);
  }
  if (spaced.length > b.series.length) {
    useBot.setState({ series: spaced.slice(-240) });
  }
}

/** Drives the bot: appends the real 30s print, then evaluates each cycle. */
export function useBotLoop(snap: LeefSnapshot) {
  const fetchedAt = snap.fetchedAt;
  const running = useBot((s) => s.running);
  const lastSnap = useRef("");
  const prevRunning = useRef(false);

  useEffect(() => {
    const justStarted = running && !prevRunning.current;
    prevRunning.current = running;

    const b = useBot.getState();
    const isNewSnap = lastSnap.current !== fetchedAt;
    if (isNewSnap) {
      lastSnap.current = fetchedAt;
      seedSeriesFromTape(snap);
      if (snap.leefUsd > 0) {
        const t = Date.parse(fetchedAt) || Date.now();
        const last = b.series[b.series.length - 1];
        if (!last || t - last.t > 15_000) b.pushSeries({ t, usd: snap.leefUsd });
      }
      if (b.position && snap.leefUsd > b.position.highUsd) {
        b.bumpPositionHigh(snap.leefUsd);
      }
    }
    if (!b.running) return;
    if (!isNewSnap && !justStarted) return;
    void runBotOnce(snap);
  }, [fetchedAt, running, snap]);
}
