import {
  adaptiveCooldownSec,
  evaluateBot,
  findBestArb,
  type ArbPlan,
  type Position,
} from "@/lib/leef/bot-engine";
import { realizedVolPerSec, usdPriceOf } from "@/lib/leef/cost-model";
import { optimizeEntrySize } from "@/lib/leef/net-edge";
import { markDeadOpportunity, opportunityFingerprint } from "@/lib/leef/opportunity";
import { fmtNum } from "@/lib/leef/format";
import { fetchAlcorRouteCached, verifyExecutableRoute } from "@/lib/leef/quote-verify";
import { verifyGrowthExact } from "@/lib/leef/growth-engine";
import { exactEntryVerdict, exactSwapVerdict } from "@/lib/leef/exact-gate";
import { exceedsMaxPositionUsd, usdToTokenBounds } from "@/lib/leef/risk-usd";
import { lastSnapshotTimings } from "@/lib/leef/snapshot";
import { bestExecutionRoute } from "@/lib/leef/route-optimizer";
import { refreshExecutionState } from "@/lib/market/execution-state";
import { governTrade, portfolioState } from "@/lib/market/portfolio-governor";
import type { LeefSnapshot } from "@/lib/leef/types";
import { parseAssetAmount, type AlcorRouteQuote } from "@/lib/wallet/alcor-route";
import { WAX_CONTRACT } from "@/lib/leef/types";
import { waxResourceBlock } from "@/lib/wallet/chain";
import { arbFloorViolation, memoMinOutSum } from "@/lib/wallet/policy";
import { assetDelta, reconcileTransfersLater, waitForTransaction } from "@/lib/wallet/reconcile";
import { signAndPushArb, signAndPushSwap } from "@/lib/wallet/sign";
import {
  abortSigning,
  beginSigning,
  emptyTimings,
  liveCapitalBlocked,
  markBroadcast,
  markConfirmed,
  markFailed,
  markUnknown,
  recordCycleTimings,
  unknownBlockReason,
} from "@/lib/wallet/trade-cycle";
import { classifyTradeError, toastTitleFor } from "@/lib/wallet/trade-error";
import { useBot } from "@/store/bot";
import { clampSyncSec, DEFAULT_SYNC_SEC, useTerminal } from "@/store/terminal";
import { useWallet } from "@/store/wallet";
import { toast } from "@/hooks/useToast";
import { lastFetchTiming } from "@/lib/fetchJson";

function equityUsdOf(balances: Record<string, number>, snap: LeefSnapshot): number {
  // Portfolio governor already canonicalizes balances and avoids double-counting
  // legacy aliases, so equity cannot merge two same-symbol contracts.
  return portfolioState(snap, balances).totalUsd;
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
  const buy = await fetchAlcorRouteCached({
    tokenInId: "wax-eosio.token",
    tokenOutId: "leef-leefmaincorp",
    amount: plan.waxIn,
    slippagePct,
    receiver: account,
  });
  const leefOut = parseAssetAmount(buy.output);
  if (!(leefOut > 0)) throw new Error("Alcor returned no LEEF for the echo");
  // Sell the buy's GUARANTEED min-received, not the quoted output — otherwise
  // a fill at the slippage floor leaves the wallet short and the atomic
  // transaction reverts.
  const leefGuaranteed = parseAssetAmount(buy.minReceived) || leefOut;

  const fetchSell = (slip: number) =>
    fetchAlcorRouteCached({
      tokenInId: "leef-leefmaincorp",
      tokenOutId: "wax-eosio.token",
      amount: leefGuaranteed,
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
/** Set when the API rate-limits us — evaluations pause until then. */
let rateLimitedUntil = 0;
/** Evaluation mutex — paper fills and live quotes must not overlap. */
let cycleInFlight = false;

/** Keep polling an UNKNOWN txid. Never submits another trade. Unlocks only on fail/confirm. */
function pollUnknown(txid: string): void {
  void (async () => {
    const rec = await reconcileTransfersLater(txid);
    if (rec.status === "failed") markFailed();
    else if (rec.status === "confirmed") markConfirmed();
    // still unknown → stay locked
  })();
}

/**
 * Evaluate the bot once against a snapshot. Exported so the desk can
 * dry-run ("what would it do now?") and force manual clips.
 *
 * Signing is exclusive. After broadcast, reconciliation is async so the
 * next market scan can prepare — but a new LIVE trade is blocked until
 * capital is known (UNKNOWN never retries).
 */
export async function runBotOnce(
  snap: LeefSnapshot,
  opts?: { force?: "buy" | "sell"; dry?: boolean },
) {
  if (opts?.dry) return await runBotOnceInner(snap, opts);
  const live = useWallet.getState().canSign();
  if (live && liveCapitalBlocked()) {
    const unknown = unknownBlockReason();
    if (unknown) {
      useBot.getState().setLastReason(unknown);
    }
    return null;
  }
  // One evaluation at a time for BOTH paper and live. Without this, overlapping
  // snapshot + on-chain-spot ticks can paper-fill (or quote) the same clip twice
  // before markTrade's cooldown lands.
  if (cycleInFlight) return null;
  cycleInFlight = true;
  try {
    return await runBotOnceInner(snap, opts);
  } finally {
    cycleInFlight = false;
  }
}

async function runBotOnceInner(
  snap: LeefSnapshot,
  opts?: { force?: "buy" | "sell"; dry?: boolean },
) {
  const cycleT0 = Date.now();
  const timings = emptyTimings();
  const snapT = lastSnapshotTimings();
  timings.snapshotFetchMs = snapT.snapshotFetchMs;
  timings.poolRefreshMs = snapT.poolRefreshMs;
  timings.tradeHistoryMs = snapT.tradeHistoryMs;
  timings.venueDiscoveryMs = snapT.venueDiscoveryMs;

  const b = useBot.getState();
  const w = useWallet.getState();
  const balances = w.balances();
  const equityUsd = equityUsdOf(balances, snap);
  const syncSec = clampSyncSec(useTerminal.getState().syncSec ?? DEFAULT_SYNC_SEC);
  const risk = {
    ...b.risk,
    maxQuoteAgeSec: Math.max(b.risk.maxQuoteAgeSec, syncSec + 15),
  };

  let decision = evaluateBot({
    now: Date.now(),
    snap,
    series: b.series,
    running: b.running,
    strategy: b.strategy,
    goals: b.goals,
    risk,
    position: b.position,
    gridAnchor: b.gridAnchor,
    balances,
    cooldownUntil: b.cooldownUntil,
    tradesThisHour: b.tradesThisHour,
    sessionRealizedUsd: b.stats.realizedUsd,
    sessionStartEquityUsd: b.stats.startEquityUsd,
    calibration: b.stats.byStrategy,
    quote: b.quote,
    base: b.base,
    growthTargets: b.growthTargets,
    growthMode: b.growthMode,
    // Danger input: infrastructure errors in the last 10 minutes.
    recentFailures: b.decisions.filter(
      (d) => d.kind === "error" && Date.now() - Date.parse(d.t) < 600_000,
    ).length,
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

  // Compact pre-trade state: refresh only critical route/price pools if the
  // engine's chain spot is stale. Never rebuild the full 11 MB universe here;
  // signAndPushSwap still obtains a fresh venue-specific executable quote.
  let book = snap;
  if (snap.source === "live") {
    const tMarket = Date.now();
    try {
      const exec = await refreshExecutionState(snap, "route" in decision ? decision.route : null);
      book = exec.snap;
      timings.poolRefreshMs = exec.refreshMs;
    } catch (err) {
      const reason = `Critical execution state unavailable: ${err instanceof Error ? err.message : "refresh failed"}`;
      b.pushDecision({ kind: "hold", mode, reason, priceUsd: snap.leefUsd });
      b.setLastReason(reason);
      return { kind: "hold", reason };
    } finally {
      timings.snapshotFetchMs = Date.now() - tMarket;
    }
  }

  const quoteTok = b.quote || "WAX";
  const baseTok = b.base || "LEEF";
  const bounds = usdToTokenBounds({
    snap: book,
    quote: quoteTok,
    base: baseTok,
    risk: b.risk,
    position: b.position,
    balances,
  });
  if ("error" in bounds) {
    b.pushDecision({ kind: "hold", mode, reason: bounds.error, priceUsd: snap.leefUsd });
    b.setLastReason(bounds.error);
    return { kind: "hold", reason: bounds.error };
  }

  // Last-second re-optimize: USD min is the floor, remaining USD capacity the ceiling.
  // Re-scan size + route on THIS book so we never fire the 30s-old candidate.
  if (decision.kind === "buy") {
    if (bounds.maxIn + 1e-12 < bounds.minIn) {
      const reason = `Effective maximum $${bounds.effectiveMaxUsd.toFixed(2)} is under min trade $${b.risk.minTradeUsd.toFixed(2)} (wallet $${bounds.walletUsd.toFixed(2)}, reserve $${(b.risk.operationalReserveUsd ?? 0).toFixed(2)}) — sitting out`;
      b.pushDecision({ kind: "hold", mode, reason, priceUsd: snap.leefUsd });
      b.setLastReason(reason);
      return { kind: "hold", reason };
    }
    const thesis =
      decision.expectedGrossPct ?? Math.max(b.goals.takeProfitPct * 0.5, 0.2);
    const tEdge = Date.now();
    const tSize = Date.now();
    const fresh = optimizeEntrySize({
      snap: book,
      tokenIn: quoteTok,
      tokenOut: baseTok,
      expectedGrossPct: thesis,
      minNetEdgePct: b.risk.minNetEdgePct,
      minIn: bounds.minIn,
      maxIn: bounds.maxIn,
      volPerSec: realizedVolPerSec(b.series),
    });
    timings.sizeOptimizationMs = Date.now() - tSize;
    timings.netEdgeMs = Date.now() - tEdge;
    timings.candidateCount = fresh?.tried.length ?? 0;
    timings.routeCount = fresh ? 1 : 0;
    if (!fresh) {
      const reason = `Pre-trade size scan found nothing in ${bounds.minIn.toFixed(4)}–${bounds.maxIn.toFixed(4)} ${quoteTok} ($${b.risk.minTradeUsd.toFixed(2)}–$${bounds.effectiveMaxUsd.toFixed(2)} effective max)`;
      b.pushDecision({ kind: "hold", mode, reason, priceUsd: snap.leefUsd });
      b.setLastReason(reason);
      return { kind: "hold", reason };
    }
    decision = {
      ...decision,
      amountWax: fresh.best.amountIn,
      route: fresh.best.route,
      reason: `${decision.reason} · pre-trade ${fresh.best.amountIn.toFixed(2)} ${quoteTok}`,
      edge: {
        netEdgePct: fresh.best.netEdgePct,
        netProfitUsd: fresh.best.netProfitUsd,
        score: decision.edge?.score ?? 0,
      },
    };

    // Universal exact-quote gate for entries: the size scan priced the book
    // with constant-product math; Alcor is CLMM. Re-run the entry thesis on
    // the venue's exact executable output for this size before the governor.
    {
      const tQuote = Date.now();
      try {
        const verified = await verifyExecutableRoute({
          route: decision.route,
          amountIn: decision.amountWax,
          slippagePct: b.risk.slippage,
          account: live ? w.account : "paper.leef",
          snap: book,
          deadlineMs: 4_000,
        });
        timings.quoteVerifyMs = Date.now() - tQuote;
        if (verified.trust !== "executable") {
          const reason = "Exact-quote gate: venue quote is not executable";
          b.pushDecision({ kind: "hold", mode, reason, priceUsd: book.leefUsd });
          b.setLastReason(reason);
          return { kind: "hold", reason };
        }
        const verdict = exactEntryVerdict({
          snap: book,
          route: decision.route,
          amountIn: decision.amountWax,
          expectedOut: verified.expectedOut,
          exitRoute: fresh.best.exitRoute,
          expectedGrossPct: thesis,
          minNetEdgePct: b.risk.minNetEdgePct,
          volPerSec: realizedVolPerSec(b.series),
        });
        if (!verdict.pass) {
          const reason = `Exact-quote gate: ${verdict.reason}`;
          b.pushDecision({ kind: "hold", mode, reason, priceUsd: book.leefUsd });
          b.setLastReason(reason);
          return { kind: "hold", reason };
        }
        decision = {
          ...decision,
          route: { ...decision.route, amountOut: verified.expectedOut },
          edge: {
            netEdgePct: verdict.netEdgePct,
            netProfitUsd: (verdict.netEdgePct / 100) * (decision.amountWax * (bounds.quoteUsd || 1)),
            score: decision.edge?.score ?? 0,
          },
          reason: `${decision.reason} · ${verdict.reason}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "exact quote failed";
        const reason = `Exact-quote gate: ${msg}`;
        b.pushDecision({ kind: "hold", mode, reason, priceUsd: book.leefUsd });
        b.setLastReason(reason);
        return { kind: "hold", reason };
      }
    }
  }
  if (decision.kind === "arb") {
    const maxIn = bounds.maxIn;
    const isEcho = decision.arbKind === "volume" || (decision.arbKind == null && b.strategy === "volume");
    const floorPct = isEcho ? -b.risk.maxEchoLossPct : b.risk.minEdgePct;
    const fresh = findBestArb(
      book,
      maxIn,
      isEcho ? -b.risk.maxEchoLossPct : floorPct,
      isEcho,
      bounds.minIn,
    );
    if (!fresh) {
      const reason = "Pre-trade arb scan found no clip in the size band";
      b.pushDecision({ kind: "hold", mode, reason, priceUsd: snap.leefUsd });
      b.setLastReason(reason);
      return { kind: "hold", reason };
    }
    decision = { ...decision, plan: fresh };
  }
  if (decision.kind === "sell") {
    const routed = bestExecutionRoute(
      book.pools,
      book.aux,
      decision.amountLeef,
      b.base || "LEEF",
      b.quote || "WAX",
    );
    if (!routed) {
      const reason = "Pre-trade sell: no executable route for this LEEF size";
      b.pushDecision({ kind: "hold", mode, reason, priceUsd: book.leefUsd });
      b.setLastReason(reason);
      return { kind: "hold", reason };
    }
    if (routed.priceImpact * 100 > b.risk.maxImpactPct) {
      const reason = `Pre-trade sell impact ${(routed.priceImpact * 100).toFixed(1)}% above cap`;
      b.pushDecision({ kind: "hold", mode, reason, priceUsd: book.leefUsd });
      b.setLastReason(reason);
      return { kind: "hold", reason };
    }
    decision = { ...decision, route: routed };
  }

  // Portfolio Governor: simulate the AFTER portfolio before execution. A
  // profitable strategy cannot consume operational inventory or create an
  // unusable concentration. It may resize a buy to the actually deployable
  // amount; strategy decides WHAT, governor decides HOW MUCH.
  if (decision.kind === "swap") {
    const governed = governTrade(book, balances, {
      tokenIn: decision.tokenIn,
      tokenOut: decision.tokenOut,
      amountIn: decision.amountIn,
      expectedOut: decision.route.amountOut,
      expectedNetProfitUsd: decision.opportunity?.expectedNetProfitUsd ?? 0,
      kind: "profit",
      route: decision.route,
    });
    if (!governed.allowed) {
      const reason = `Portfolio governor: ${governed.reason}`;
      b.pushDecision({ kind: "hold", mode, reason, priceUsd: book.leefUsd });
      b.setLastReason(reason);
      return { kind: "hold", reason };
    }
    if (governed.allowedAmountIn + 1e-12 < decision.amountIn) {
      const resized = bestExecutionRoute(
        book.pools,
        book.aux,
        governed.allowedAmountIn,
        decision.tokenIn,
        decision.tokenOut,
      );
      if (!resized) {
        const reason = "Portfolio governor reserve leaves no viable next hop";
        b.pushDecision({ kind: "hold", mode, reason, priceUsd: book.leefUsd });
        b.setLastReason(reason);
        return { kind: "hold", reason };
      }
      decision = {
        ...decision,
        amountIn: governed.allowedAmountIn,
        route: resized,
        reason: `${decision.reason} · ${governed.reason}`,
      };
    }

    // Depth guard (split-or-skip): the router splits across books when that
    // pays, so if the winning route STILL moves the market past the risk
    // cap, the position is too big for the pool — skip, don't force it.
    if (decision.route.priceImpact * 100 > risk.maxImpactPct) {
      const reason = `Too big for the book — ${(decision.route.priceImpact * 100).toFixed(1)}% impact > ${risk.maxImpactPct}% cap (already split-optimized) — skipping`;
      b.pushDecision({ kind: "hold", mode: "live", reason, priceUsd: book.leefUsd });
      b.setLastReason(reason);
      return { kind: "hold", reason };
    }

    // Treasure growth: the graph proposed, now the EXACT venue quote must
    // approve. Re-run the growth thesis on the real executable output for
    // this size — if the fresh quote no longer grows the treasure, HOLD
    // before any signer is touched.
    if (decision.growthPlan) {
      const tQuote = Date.now();
      try {
        const verified = await verifyExecutableRoute({
          route: decision.route,
          amountIn: decision.amountIn,
          slippagePct: b.risk.slippage,
          account: live ? w.account : "paper.leef",
          snap: book,
          deadlineMs: 4_000,
        });
        timings.quoteVerifyMs = Date.now() - tQuote;
        if (verified.trust !== "executable") {
          const reason = "Growth exact-quote gate: venue quote is not executable";
          b.pushDecision({ kind: "hold", mode, reason, priceUsd: book.leefUsd });
          b.setLastReason(reason);
          return { kind: "hold", reason };
        }
        const verdict = verifyGrowthExact(
          decision.growthPlan,
          decision.amountIn,
          verified.expectedOut,
          book,
        );
        const exactTag = verified.exactness === "exact" ? "" : " · fresh-model venue (min-out is the hard guard)";
          if (!verdict.pass) {
            const reason = `Growth exact-quote gate: ${verdict.reason}`;
            b.pushDecision({ kind: "hold", mode, reason, priceUsd: book.leefUsd });
            b.setLastReason(reason);
            return { kind: "hold", reason };
          }
          decision = {
            ...decision,
            // Paper fills and P&L settle from the exact venue quote too.
            route: { ...decision.route, amountOut: verified.expectedOut },
            reason: `${decision.reason} · ${verdict.reason}${exactTag}`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : "exact quote failed";
          const reason = `Growth exact-quote gate: ${msg}`;
          b.pushDecision({ kind: "hold", mode, reason, priceUsd: book.leefUsd });
          b.setLastReason(reason);
          return { kind: "hold", reason };
        }
      }

      // Universal exact-quote gate for every other swap (tape / next-hop /
      // volume-x): the venue must confirm the decision's own net floor.
      if (!decision.growthPlan && decision.minNetPct != null) {
        const tQuote = Date.now();
        try {
          const verified = await verifyExecutableRoute({
            route: decision.route,
            amountIn: decision.amountIn,
            slippagePct: b.risk.slippage,
            account: live ? w.account : "paper.leef",
            snap: book,
            deadlineMs: 4_000,
          });
          timings.quoteVerifyMs = Date.now() - tQuote;
          if (verified.trust !== "executable") {
            const reason = "Exact-quote gate: venue quote is not executable";
            b.pushDecision({ kind: "hold", mode, reason, priceUsd: book.leefUsd });
            b.setLastReason(reason);
            return { kind: "hold", reason };
          }
          const verdict = exactSwapVerdict({
            snap: book,
            route: decision.route,
            amountIn: decision.amountIn,
            expectedOut: verified.expectedOut,
            guaranteedOut: verified.guaranteedOut,
            minNetPct: decision.minNetPct,
          });
          const venueTag = verified.exactness === "exact" ? "" : " · fresh-model venue";
          if (!verdict.pass) {
            const reason = `Exact-quote gate: ${verdict.reason}`;
            b.pushDecision({ kind: "hold", mode, reason, priceUsd: book.leefUsd });
            b.setLastReason(reason);
            return { kind: "hold", reason };
          }
          decision = {
            ...decision,
            route: { ...decision.route, amountOut: verified.expectedOut },
            reason: `${decision.reason} · ${verdict.reason}${venueTag}`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : "exact quote failed";
          const reason = `Exact-quote gate: ${msg}`;
          b.pushDecision({ kind: "hold", mode, reason, priceUsd: book.leefUsd });
          b.setLastReason(reason);
          return { kind: "hold", reason };
        }
      }
    }

  if (decision.kind === "buy") {
    const tRisk = Date.now();
    const governed = governTrade(book, balances, {
      tokenIn: quoteTok,
      tokenOut: baseTok,
      amountIn: decision.amountWax,
      expectedOut: decision.route.amountOut,
      expectedNetProfitUsd: decision.edge?.netProfitUsd ?? 0,
      kind: "profit",
      route: decision.route,
    });
    timings.riskMs = Date.now() - tRisk;
    if (!governed.allowed) {
      const reason = `Portfolio governor: ${governed.reason}`;
      b.pushDecision({ kind: "hold", mode, reason, priceUsd: book.leefUsd });
      b.setLastReason(reason);
      return { kind: "hold", reason };
    }
    if (governed.allowedAmountIn + 1e-12 < decision.amountWax) {
      const resized = bestExecutionRoute(
        book.pools,
        book.aux,
        governed.allowedAmountIn,
        quoteTok,
        baseTok,
      );
      if (!resized || governed.allowedAmountIn < bounds.minIn) {
        const reason = "Portfolio governor reserve leaves no economically viable clip";
        b.pushDecision({ kind: "hold", mode, reason, priceUsd: book.leefUsd });
        b.setLastReason(reason);
        return { kind: "hold", reason };
      }
      decision = {
        ...decision,
        amountWax: governed.allowedAmountIn,
        route: resized,
        reason: `${decision.reason} · ${governed.reason}`,
      };
    }
  }

  // WAX resource preflight: never sign a live trade on an exhausted account.
  if (
    live &&
    (decision.kind === "buy" || decision.kind === "sell" || decision.kind === "arb" || decision.kind === "swap")
  ) {
    const block = waxResourceBlock(w.cpuPct, w.netPct, w.ramPct);
    if (block) {
      b.pushDecision({ kind: "hold", mode, reason: block, priceUsd: snap.leefUsd });
      b.setLastReason(block);
      return { kind: "hold", reason: block };
    }
  }

  try {
    if (decision.kind === "buy") {
      const minOut = decision.route.amountOut * (1 - b.risk.slippage / 100);
      let amountLeef = minOut;
      let txid: string | undefined;
      let note = "";
      if (live) {
        if (exceedsMaxPositionUsd({
          snap: book,
          base: b.base || "LEEF",
          risk: b.risk,
          position: b.position,
          extraBaseAmount: amountLeef,
        })) {
          const reason = `Final check: fill would exceed $${b.risk.maxPositionUsd.toFixed(0)} max position`;
          b.pushDecision({ kind: "hold", mode, reason, priceUsd: snap.leefUsd });
          b.setLastReason(reason);
          return { kind: "hold", reason };
        }
        if (!beginSigning()) return decision;
        const tSign = Date.now();
        try {
          const exec = await signAndPushSwap({
            account: w.account,
            permission: w.permission,
            route: decision.route,
            amountIn: decision.amountWax,
            slippagePct: b.risk.slippage,
            snap: book,
          });
          timings.signMs = Date.now() - tSign;
          timings.broadcastMs = timings.signMs;
          txid = exec.txid;
          markBroadcast(txid);
          amountLeef = exec.expectedOut > 0 ? exec.expectedOut : minOut;
          const tConf = Date.now();
          const rec = await waitForTransaction(txid, { budgetMs: 1_200, attempts: 3, delayMs: 200 });
          timings.confirmationMs = Date.now() - tConf;
          if (rec.status === "failed") {
            markFailed();
            throw new Error(rec.error);
          }
          if (rec.status === "confirmed") {
            const actual = assetDelta(rec.transfers, w.account, b.base || "LEEF");
            if (actual > 0) amountLeef = actual;
            note = rec.transfers.length ? " · confirmed on-chain" : " · included (transfers pending)";
            markConfirmed();
            if (rec.transfers.length === 0) {
              void reconcileTransfersLater(txid);
            }
          } else {
            markUnknown(txid);
            note = " · broadcast, confirmation pending — not retrying";
            void pollUnknown(txid);
          }
        } catch (err) {
          abortSigning();
          throw err;
        }
      } else {
        w.applyPaperFill(b.quote || "WAX", decision.amountWax, b.base || "LEEF", amountLeef);
      }
      // Average into an existing position (DCA) or open a fresh one.
      // Costs are USD: quote-side spend × the quote token's oracle price,
      // base-side marks × the base token's oracle price — no WAX/LEEF wiring.
      const quoteUsdPx = bounds.quoteUsd;
      const baseUsdPx = usdPriceOf(b.base || "LEEF", book) || snap.leefUsd;
      const prev = b.position;
      const position: Position = prev
        ? {
            amountLeef: prev.amountLeef + amountLeef,
            entryUsd:
              (prev.entryCostUsd + decision.amountWax * quoteUsdPx) /
              Math.max(prev.amountLeef + amountLeef, 1e-9),
            entryCostUsd: prev.entryCostUsd + decision.amountWax * quoteUsdPx,
            entryWax: prev.entryWax + decision.amountWax,
            since: prev.since,
            highUsd: Math.max(prev.highUsd, baseUsdPx),
            mode,
            // Weight the predicted edge by the new capital entering.
            predEdgePct:
              decision.edge != null
                ? ((prev.predEdgePct ?? decision.edge.netEdgePct) * prev.entryWax +
                    decision.edge.netEdgePct * decision.amountWax) /
                  Math.max(prev.entryWax + decision.amountWax, 1e-9)
                : prev.predEdgePct,
            strategy: prev.strategy ?? b.strategy,
          }
        : {
            amountLeef,
            entryUsd: baseUsdPx,
            entryCostUsd: decision.amountWax * quoteUsdPx,
            entryWax: decision.amountWax,
            since: Date.now(),
            highUsd: baseUsdPx,
            mode,
            predEdgePct: decision.edge?.netEdgePct,
            strategy: b.strategy,
          };
      b.setPosition(position);
      b.setGridAnchor(baseUsdPx);
      b.markTrade(adaptiveCooldownSec(b.risk.cooldownSec, b.strategy, b.stats.lastPnlUsd));
      b.pushDecision({
        kind: "buy",
        mode,
        reason: decision.reason + note,
        priceUsd: snap.leefUsd,
        txid,
      });
      toast({
        title: `${live ? "Live" : "Paper"} buy · ${fmtNum(amountLeef, { compact: true })} LEEF`,
        description: decision.reason + note + (txid ? ` · tx ${txid.slice(0, 10)}…` : ""),
      });
      return decision;
    }

    if (decision.kind === "sell") {
      const position = b.position;
      let waxOut = decision.route.amountOut;
      let txid: string | undefined;
      let note = "";
      const t0 = Date.now();
      if (live) {
        if (!beginSigning()) return decision;
        const tSign = Date.now();
        try {
          const exec = await signAndPushSwap({
            account: w.account,
            permission: w.permission,
            route: decision.route,
            amountIn: decision.amountLeef,
            slippagePct: b.risk.slippage,
            snap: book,
          });
          timings.signMs = Date.now() - tSign;
          timings.broadcastMs = timings.signMs;
          txid = exec.txid;
          markBroadcast(txid);
          if (exec.expectedOut > 0) waxOut = exec.expectedOut;
          const tConf = Date.now();
          const rec = await waitForTransaction(txid, { budgetMs: 1_200, attempts: 3, delayMs: 200 });
          timings.confirmationMs = Date.now() - tConf;
          if (rec.status === "failed") {
            markFailed();
            throw new Error(rec.error);
          }
          if (rec.status === "confirmed") {
            const actual = assetDelta(rec.transfers, w.account, "WAX", WAX_CONTRACT);
            if (actual > 0) waxOut = actual;
            note = rec.transfers.length ? " · confirmed on-chain" : " · included (transfers pending)";
            markConfirmed();
            if (rec.transfers.length === 0) void reconcileTransfersLater(txid);
          } else {
            markUnknown(txid);
            note = " · broadcast, confirmation pending — not retrying";
            void pollUnknown(txid);
          }
        } catch (err) {
          abortSigning();
          throw err;
        }
      } else {
        w.applyPaperFill(b.base || "LEEF", decision.amountLeef, b.quote || "WAX", waxOut);
      }
      const pnlUsd = position ? waxOut * bounds.quoteUsd - position.entryCostUsd : 0;
      b.setPosition(null);
      b.setGridAnchor(usdPriceOf(b.base || "LEEF", book) || snap.leefUsd);
      b.markTrade(adaptiveCooldownSec(b.risk.cooldownSec, b.strategy, pnlUsd));
      b.recordResult(pnlUsd, equityUsd + pnlUsd);
      // Calibration: predicted edge (stored at entry) vs the realized edge.
      b.recordStrategyPerf(position?.strategy ?? b.strategy, {
        pnlUsd,
        predEdgePct: position?.predEdgePct ?? null,
        realEdgePct:
          position && position.entryCostUsd > 0 ? (pnlUsd / position.entryCostUsd) * 100 : 0,
        latencyMs: live ? Date.now() - t0 : null,
      });
      b.pushDecision({
        kind: "sell",
        mode,
        reason: decision.reason + note,
        priceUsd: snap.leefUsd,
        txid,
        pnlUsd,
      });
      toast({
        title: `${live ? "Live" : "Paper"} sell · ${fmtNum(waxOut, { digits: 2 })} WAX · ${
          pnlUsd >= 0 ? "+" : ""
        }$${pnlUsd.toFixed(2)}`,
        description: decision.reason + note + (txid ? ` · tx ${txid.slice(0, 10)}…` : ""),
        variant: pnlUsd < 0 ? "destructive" : "default",
      });
      return decision;
    }

    if (decision.kind === "swap") {
      let txid: string | undefined;
      let note = "";
      let outAmt = decision.route.amountOut;
      if (live) {
        if (!beginSigning()) return decision;
        try {
          const exec = await signAndPushSwap({
            account: w.account,
            permission: w.permission,
            route: decision.route,
            amountIn: decision.amountIn,
            slippagePct: b.risk.slippage,
            snap: book,
          });
          txid = exec.txid;
          markBroadcast(txid);
          if (exec.expectedOut > 0) outAmt = exec.expectedOut;
          const rec = await waitForTransaction(txid, { budgetMs: 1_200, attempts: 3, delayMs: 200 });
          if (rec.status === "failed") {
            markFailed();
            throw new Error(rec.error);
          }
          if (rec.status === "confirmed") {
            markConfirmed();
            note = rec.transfers.length ? " · confirmed on-chain" : " · included";
            if (rec.transfers.length === 0) void reconcileTransfersLater(txid);
          } else {
            markUnknown(txid);
            note = " · broadcast, confirmation pending — not retrying";
            void pollUnknown(txid);
          }
        } catch (err) {
          abortSigning();
          throw err;
        }
      } else {
        w.applyPaperFill(decision.tokenIn, decision.amountIn, decision.tokenOut, outAmt);
      }
      const inUsd = decision.amountIn * (usdPriceOf(decision.tokenIn, book) || 0);
      const outUsd = outAmt * (usdPriceOf(decision.tokenOut, book) || 0);
      const tapePnl = outUsd - inUsd;
      b.markTrade(adaptiveCooldownSec(b.risk.cooldownSec, b.strategy, tapePnl));
      if (b.strategy === "volume-x" || /Volume-X|Unleashed tape/i.test(decision.reason)) {
        b.recordVolume(inUsd + outUsd, -tapePnl);
        b.recordResult(tapePnl, equityUsd + tapePnl);
      }
      b.pushDecision({
        kind: "swap",
        mode,
        reason: decision.reason + note,
        priceUsd: snap.leefUsd,
        txid,
        pnlUsd: tapePnl,
      });
      toast({
        title: `${live ? "Live" : "Unsigned"} ${decision.tokenIn}→${decision.tokenOut}`,
        description: decision.reason + note + (txid ? ` · tx ${txid.slice(0, 10)}…` : ""),
      });
      return decision;
    }

    if (decision.kind === "arb") {
      let plan = decision.plan;
      // The hard floor this arb must enforce on-chain: spread arbs enforce the
      // profit floor; volume echoes enforce the loss budget (negative floor).
      // The decision's arbKind (not the globally selected strategy) decides —
      // the auto strategy emits both kinds.
      const isEcho =
        decision.arbKind === "volume" || (decision.arbKind == null && b.strategy === "volume");
      const floorPct = isEcho ? -b.risk.maxEchoLossPct : b.risk.minEdgePct;
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
        if (isEcho && costPct > b.risk.maxEchoLossPct) {
          // Real round-trip cost exceeds the budget — skip, don't burn CPU.
          const reason = `Alcor round-trip costs ${costPct.toFixed(2)}% — above the ${b.risk.maxEchoLossPct}% budget`;
          b.setLastReason(reason);
          b.pushDecision({ kind: "hold", mode, reason, priceUsd: snap.leefUsd });
          return { kind: "hold", reason };
        }
        if (!isEcho && plan.profitPct * 100 < b.risk.minEdgePct) {
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
      let note = "";
      /** Net WAX delta read from the confirmed transaction (null = estimate). */
      let realizedWax: number | null = null;
      const t0 = Date.now();
      if (live) {
        if (!beginSigning()) return decision;
        const tSign = Date.now();
        try {
          const res = await signAndPushArb({
            account: w.account,
            permission: w.permission,
            plan,
            minProfitPct: floorPct,
            snap,
          });
          timings.signMs = Date.now() - tSign;
          timings.broadcastMs = timings.signMs;
          txid = res.txid;
          markBroadcast(txid);
          const tConf = Date.now();
          const rec = await waitForTransaction(txid, { budgetMs: 1_200, attempts: 3, delayMs: 200 });
          timings.confirmationMs = Date.now() - tConf;
          if (rec.status === "failed") {
            markFailed();
            throw new Error(rec.error);
          }
          if (rec.status === "confirmed") {
            realizedWax = assetDelta(rec.transfers, w.account, "WAX", WAX_CONTRACT);
            note = rec.transfers.length ? " · confirmed on-chain" : " · included (transfers pending)";
            markConfirmed();
            if (rec.transfers.length === 0) void reconcileTransfersLater(txid);
          } else {
            markUnknown(txid);
            note = " · broadcast, confirmation pending — not retrying";
            void pollUnknown(txid);
          }
        } catch (err) {
          abortSigning();
          throw err;
        }
      } else {
        // Same symbol in and out — the fill nets the profit onto the balance.
        w.applyPaperFill("WAX", plan.waxIn, "WAX", plan.waxOut);
      }
      const pnlUsd =
        realizedWax != null
          ? realizedWax * snap.waxUsd
          : (plan.waxOut - plan.waxIn) * snap.waxUsd;
      b.markTrade(adaptiveCooldownSec(b.risk.cooldownSec, b.strategy, pnlUsd));
      b.recordResult(pnlUsd, equityUsd + pnlUsd);
      // Calibration: the router-quoted edge vs what the chain actually paid.
      b.recordStrategyPerf(b.strategy, {
        pnlUsd,
        predEdgePct: plan.profitPct * 100,
        realEdgePct:
          (realizedWax != null ? realizedWax / plan.waxIn : plan.waxOut / plan.waxIn - 1) * 100,
        latencyMs: live ? Date.now() - t0 : null,
      });
      if (isEcho) {
        b.recordVolume((plan.waxIn + plan.waxOut) * snap.waxUsd, -pnlUsd);
      }
      b.pushDecision({
        kind: "arb",
        mode,
        reason: decision.reason + note,
        priceUsd: snap.leefUsd,
        txid,
        pnlUsd,
      });
      const diff = realizedWax ?? plan.waxOut - plan.waxIn;
      toast({
        title: `${live ? "Live" : "Paper"} ${isEcho ? "echo" : "arb"} · ${
          diff >= 0 ? "+" : ""
        }${fmtNum(diff, { digits: 3 })} WAX`,
        description: decision.reason + note + (txid ? ` · tx ${txid.slice(0, 10)}…` : ""),
      });
      return decision;
    }
  } catch (err) {
    const { code, message } = classifyTradeError(err);
    if (code === "API_RATE_LIMIT" || code === "QUOTE_FAILURE" || code === "RPC_FAILURE") {
      const backoffSec = code === "API_RATE_LIMIT" ? 180 : 30;
      rateLimitedUntil = Date.now() + backoffSec * 1_000;
      const reason = `${code}: ${message} — backing off ${backoffSec}s`;
      b.pushDecision({ kind: "error", mode, reason, priceUsd: snap.leefUsd });
      b.setLastReason(reason);
      toast({ title: toastTitleFor(code), description: reason });
      return decision;
    }
    const reason = `${code}: ${message}`;
    b.pushDecision({ kind: "error", mode, reason, priceUsd: snap.leefUsd });
    b.setLastReason(reason);
    toast({ title: toastTitleFor(code), description: message, variant: "destructive" });
    // Don't hammer the same dead clip next cycle — look for something else.
    const fp =
      (decision.kind === "buy" || decision.kind === "arb") && decision.opportunity
        ? decision.opportunity.fingerprint
        : opportunityFingerprint({
            kind: decision.kind,
            tokenIn: b.quote || "WAX",
            tokenOut: b.base || "LEEF",
          });
    const coolMs =
      code === "QUOTE_FAILURE" || code === "RPC_FAILURE" || code === "API_RATE_LIMIT"
        ? 30_000
        : 12_000;
    markDeadOpportunity(fp, coolMs);
    return decision;
  } finally {
    const fetchTiming = lastFetchTiming();
    if (fetchTiming) {
      timings.queueWaitMs = fetchTiming.queueWaitMs;
      timings.networkMs = fetchTiming.networkMs;
      timings.parseMs = fetchTiming.parseMs;
    }
    timings.totalTradeCycleMs = Date.now() - cycleT0;
    recordCycleTimings(timings);
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
  // The tape is LEEF fills — seeding it for a non-LEEF base would skew the
  // indicator warmup with the wrong asset's price history.
  if ((b.base || "LEEF").toUpperCase() !== "LEEF") return;
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

/**
 * Per-snapshot bot bookkeeping + evaluation driver.
 *
 * Used to live inside a React effect; now a plain function the MarketEngine
 * calls on every fresh (or on-chain patched) snapshot — the trading loop
 * keeps running no matter what the component tree does.
 */
let lastSeenSnap = "";
let prevRunning = false;

export async function botOnSnapshot(snap: LeefSnapshot): Promise<void> {
  const b = useBot.getState();
  const justStarted = b.running && !prevRunning;
  prevRunning = b.running;

  const identity = `${snap.fetchedAt}|${snap.spotAt ?? ""}`;
  const isNewSnap = lastSeenSnap !== identity;
  if (isNewSnap) {
    lastSeenSnap = identity;
    seedSeriesFromTape(snap);
    // The signal series tracks the BASE token's USD mark (LEEF by default,
    // but any configured base) — strategy math is generic over it.
    const baseUsd = usdPriceOf(b.base || "LEEF", snap) || snap.leefUsd;
    if (baseUsd > 0) {
      const t = Date.parse(snap.fetchedAt) || Date.now();
      const last = b.series[b.series.length - 1];
      if (!last || t - last.t > 15_000) b.pushSeries({ t, usd: baseUsd });
    }
    if (b.position && baseUsd > b.position.highUsd) {
      b.bumpPositionHigh(baseUsd);
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
  await runBotOnce(snap);
}
