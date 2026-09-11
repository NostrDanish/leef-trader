import { useEffect, useRef } from "react";
import { evaluateBot, type ArbPlan, type Position } from "@/lib/leef/bot-engine";
import { fmtNum } from "@/lib/leef/format";
import type { LeefSnapshot } from "@/lib/leef/types";
import { fetchAlcorRoute, parseAssetAmount, type AlcorRouteQuote } from "@/lib/wallet/alcor-route";
import { arbFloorViolation, memoMinOutSum } from "@/lib/wallet/policy";
import { signAndPushArb, signAndPushSwap } from "@/lib/wallet/sign";
import { useBot } from "@/store/bot";
import { useWallet } from "@/store/wallet";
import { toast } from "@/hooks/useToast";

function equityUsdOf(balances: Record<string, number>, snap: LeefSnapshot): number {
  return (
    (balances.WAX ?? 0) * snap.waxUsd + (balances.LEEF ?? 0) * snap.leefUsd
  );
}

/**
 * Replace the local constant-product quote with Alcor's CLMM route before
 * broadcast. The return leg's min-out must enforce the profit floor on-chain
 * — when the quoted output clears the floor but the slippage-guarded min-out
 * doesn't, the sell leg is re-quoted once with a tighter guard that still
 * clears it. (Slippage only moves minReceived, not the quoted output.)
 */
async function quoteArbPlan(
  plan: ArbPlan,
  account: string,
  slippagePct: number,
  minProfitPct: number,
): Promise<ArbPlan> {
  const buy = await fetchAlcorRoute({
    tokenInId: "wax-eosio.token",
    tokenOutId: "leef-leefmaincorp",
    amount: plan.waxIn,
    slippagePct,
    receiver: account,
  });
  const leefOut = parseAssetAmount(buy.output);
  if (!(leefOut > 0)) throw new Error("Alcor returned no LEEF for the echo");

  const fetchSell = (slip: number) =>
    fetchAlcorRoute({
      tokenInId: "leef-leefmaincorp",
      tokenOutId: "wax-eosio.token",
      amount: leefOut,
      slippagePct: slip,
      receiver: account,
    });

  let sell: AlcorRouteQuote = await fetchSell(slippagePct);
  let waxOut = parseAssetAmount(sell.output);
  if (!(waxOut > 0)) throw new Error("Alcor returned no WAX for the echo");

  const floorWax = plan.waxIn * (1 + minProfitPct / 100);
  const legsOf = (q: AlcorRouteQuote) =>
    q.swaps.map((s) => ({ input: s.input, memo: s.memo }));
  if (
    waxOut >= floorWax &&
    memoMinOutSum(legsOf(sell), account) < floorWax
  ) {
    const slipMax = (1 - floorWax / waxOut) * 100;
    if (slipMax >= 0.05) {
      sell = await fetchSell(Math.min(slippagePct, slipMax * 0.9));
      waxOut = parseAssetAmount(sell.output) || waxOut;
    }
  }

  return {
    ...plan,
    leefMid: leefOut,
    waxOut,
    profitPct: waxOut / plan.waxIn - 1,
    buyLegs: buy.swaps.map((s) => ({
      input: s.input,
      output: s.output,
      memo: s.memo,
      route: s.route,
    })),
    sellLegs: sell.swaps.map((s) => ({
      input: s.input,
      output: s.output,
      memo: s.memo,
      route: s.route,
    })),
    quotedLeef: leefOut,
    quotedWax: waxOut,
  };
}

let lastHoldReason = "";
let holdStreak = 0;
let executing = false;
/** Set when the API rate-limits us — evaluations pause until then. */
let rateLimitedUntil = 0;

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
      let plan = decision.plan;
      // The hard floor this arb must enforce on-chain: spread arbs enforce the
      // profit floor; volume echoes enforce the loss budget (negative floor).
      const floorPct =
        b.strategy === "volume" ? -b.risk.maxEchoLossPct : b.risk.minEdgePct;
      {
        try {
          // Always re-quote through Alcor's CLMM router — the local
          // constant-product estimate is not what the chain will fill.
          plan = await quoteArbPlan(
            plan,
            live ? w.account : "paper.leef",
            b.risk.slippage,
            floorPct,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Alcor router failed";
          b.pushDecision({ kind: "error", mode, reason: msg, priceUsd: snap.leefUsd });
          b.setLastReason(msg);
          toast({ title: "Volume quote failed", description: msg, variant: "destructive" });
          return decision;
        }
        const costPct = (1 - plan.waxOut / plan.waxIn) * 100;
        if (b.strategy === "volume" && costPct > b.risk.maxEchoLossPct) {
          // Real round-trip cost exceeds the budget — skip, don't burn CPU.
          const reason = `Alcor round-trip costs ${costPct.toFixed(2)}% — above the ${b.risk.maxEchoLossPct}% budget`;
          b.setLastReason(reason);
          b.pushDecision({ kind: "hold", mode, reason, priceUsd: snap.leefUsd });
          return { kind: "hold", reason };
        }
        if (b.strategy === "spread" && plan.profitPct * 100 < b.risk.minEdgePct) {
          const reason = `Alcor spread ${ (plan.profitPct * 100).toFixed(2)}% is below the ${b.risk.minEdgePct}% floor`;
          b.setLastReason(reason);
          b.pushDecision({ kind: "hold", mode, reason, priceUsd: snap.leefUsd });
          return { kind: "hold", reason };
        }
        // Transaction-level invariant, checked on the ENFORCED memo min-outs
        // (not the quoted output) before we ask for any signature. The signer
        // re-checks the same invariant at the signing boundary.
        if (live) {
          const floorViolation = arbFloorViolation({
            waxIn: plan.waxIn,
            minProfitPct: floorPct,
            buyLegs: plan.buyLegs ?? [],
            sellLegs: plan.sellLegs ?? [],
            account: w.account,
          });
          if (floorViolation) {
            const reason = `Arb blocked — ${floorViolation}`;
            b.setLastReason(reason);
            b.pushDecision({ kind: "hold", mode, reason, priceUsd: snap.leefUsd });
            return { kind: "hold", reason };
          }
        }
      }
      let txid: string | undefined;
      if (live) {
        const res = await signAndPushArb({
          account: w.account,
          permission: w.permission,
          plan,
          minProfitPct: floorPct,
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
    if (msg.includes("429")) {
      // Rate limited — back off instead of retrying every cycle.
      rateLimitedUntil = Date.now() + 3 * 60_000;
      const reason = "Rate limited by the API — backing off for 3 minutes";
      b.pushDecision({ kind: "error", mode, reason, priceUsd: snap.leefUsd });
      b.setLastReason(reason);
      toast({ title: "Rate limited", description: reason });
      return decision;
    }
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
    if (Date.now() < rateLimitedUntil) {
      if (b.lastReason !== "rate-limited") {
        b.setLastReason(
          `Rate limited — paused until ${new Date(rateLimitedUntil).toISOString().slice(11, 19)} UTC`,
        );
      }
      return;
    }
    void runBotOnce(snap);
  }, [fetchedAt, running, snap]);
}
