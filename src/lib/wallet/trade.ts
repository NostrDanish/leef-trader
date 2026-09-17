import { rankExecutionRoutes, routeSignature, splitSlices } from "@/lib/leef/route-optimizer";
import { exactSwapVerdict } from "@/lib/leef/exact-gate";
import { journal } from "@/lib/leef/journal";
import { PLATFORM_FEE_MEMO, platformFeeOn } from "@/lib/leef/platform-fee";
import { verifyExecutableRoute } from "@/lib/leef/quote-verify";
import type { SwapRoute } from "@/lib/leef/types";
import { refreshExecutionState } from "@/lib/market/execution-state";
import { governTrade } from "@/lib/market/portfolio-governor";
import type { LeefSnapshot } from "@/lib/leef/types";
import { assetDelta } from "./reconcile";
import { signAndPushBatch, signAndPushSwap, type BatchLeg } from "./sign";
import { coordinateCapitalMovement } from "./execution-coordinator";
import { withTransientPreparationRetry } from "./retry-policy";
import { TradeError } from "./trade-error";
import { metaOf } from "./tokens";
import { balanceForIdentifier } from "./balances";
import { parseAssetAmount, type AlcorRouteQuote } from "./alcor-route";
import { fetchAlcorRouteCached } from "@/lib/leef/quote-verify";
import { useWallet } from "@/store/wallet";

export type SwapOutcome = {
  mode: "paper" | "live";
  amountOut: number;
  routeLabel: string;
  txid?: string;
  /** Live only: whether the chain confirmed the fill (else quoted estimate). */
  confirmed?: boolean;
};

/**
 * Hard depth cap for manual swaps. The router splits across books when that
 * helps; beyond this impact even the best split is a bad trade. Strategies
 * run much tighter (risk.maxImpactPct) — this is the never-cross line.
 */
export const MAX_SWAP_IMPACT_PCT = 10;

/**
 * Per-tx CPU budget guard for manual swaps. Each router swap is a CLMM
 * action; too many in one transaction reverts with tx_cpu_usage_exceeded
 * (and repeated reverts throttle the account). Refuse BEFORE signing and
 * tell the user the fix — pin a simpler route or shrink the size.
 */
export const MAX_MANUAL_SWAP_ACTIONS = 6;

/**
 * Execute one swap from the Quotes desk (or anywhere) — paper fill on the
 * simulated book when no signer is connected, live on-chain otherwise.
 */
export async function executeSwap(opts: {
  snap: LeefSnapshot;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  slippage: number;
  /** Graph depth cap for route search (default: router's own). */
  maxHops?: number;
  /**
   * Pinned route path signature from the Quotes desk (see routeSignature).
   * A pinned route is executed or nothing happens — it never silently falls
   * back to a different route (the user chose THIS path through the market).
   */
  routeSig?: string;
}): Promise<SwapOutcome> {
  if (!(opts.amountIn > 0)) throw new Error("Enter an amount first");
  // Same token both sides = a ROUND TRIP (LEEF→WUF→WAX→LEEF). Cycles are
  // where poisoned books produce fantasy yields (+56% at "0% impact"), so a
  // cycle is never trusted from local math: the venue must re-quote it and
  // the chain-guaranteed output must not lose.
  const isCycle = opts.tokenIn.toUpperCase() === opts.tokenOut.toUpperCase();
  const w = useWallet.getState();
  const have = balanceForIdentifier(w.balances(), opts.snap.universe, opts.tokenIn);
  if (have < opts.amountIn) {
    throw new Error(
      `Need ${opts.amountIn} ${opts.tokenIn.toUpperCase()}, spendable ${have.toFixed(4)}`,
    );
  }
  const pickRoute = (pools: LeefSnapshot["pools"], aux: LeefSnapshot["aux"]): SwapRoute | null => {
    const ranked = rankExecutionRoutes(
      pools,
      aux,
      opts.amountIn,
      opts.tokenIn,
      opts.tokenOut,
      opts.maxHops,
    );
    if (!opts.routeSig) return ranked[0] ?? null;
    return ranked.find((r) => routeSignature(r) === opts.routeSig) ?? null;
  };
  // Size-specific route from the engine cache, then refresh ONLY its critical
  // pools when stale. The signer still obtains the final executable quote.
  let book = opts.snap;
  let route = pickRoute(book.pools, book.aux);
  if (!route) {
    throw new Error(
      opts.routeSig
        ? "Pinned route isn't executable for this pair and size — re-pick or switch to Auto"
        : isCycle
          ? "No round trip route for this token and size"
          : "No backed route for this pair and size",
    );
  }
  if (isCycle && route.legs.length < 2) {
    throw new Error("A round trip needs at least two legs — no cycle found for this size");
  }
  if (opts.snap.source === "live") {
    const prepared = await withTransientPreparationRetry({
      prepare: async (_attempt, action) => {
        const exec = await refreshExecutionState(
          opts.snap,
          route,
          action === "none" ? 8_000 : 0,
        );
        const rerouted = pickRoute(exec.snap.pools, exec.snap.aux);
        if (!rerouted) {
          throw new TradeError(
            "ROUTE_DISAPPEARED",
            opts.routeSig
              ? "Pinned route disappeared after the book refresh — re-pick or switch to Auto"
              : "Route disappeared after critical-pool refresh",
          );
        }
        return { book: exec.snap, route: rerouted };
      },
    });
    book = prepared.book;
    route = prepared.route;
  }

  // Cycle firewall: venue-exact re-quote + no-loss floor before anything is
  // signed. If the venue won't pay what the local book claimed, we refuse
  // here — the user sees the real number, never signs the fantasy.
  let preQuoted: AlcorRouteQuote | undefined;
  if (isCycle) {
    const t0 = Date.now();
    const verified = await verifyExecutableRoute({
      route,
      amountIn: opts.amountIn,
      slippagePct: opts.slippage,
      account: w.canSign() ? w.account : "paper.leef",
      snap: book,
      deadlineMs: 6_000,
    });
    if (verified.trust !== "executable") {
      journal({
        kind: "gate", gate: "swap", pass: false, strategy: "manual",
        reason: `cycle: venue quote not executable (attempt on ${route.poolIds.join(">")})`,
        verifyMs: Date.now() - t0, leefUsd: book.leefUsd, waxUsd: book.waxUsd,
      });
      throw new TradeError("MODEL_ONLY", "Round trip is not executable at the venue right now");
    }
    const verdict = exactSwapVerdict({
      snap: book,
      route,
      amountIn: opts.amountIn,
      expectedOut: verified.expectedOut,
      guaranteedOut: verified.guaranteedOut,
      minNetPct: 0, // a manual round trip may never intentionally lose
    });
    journal({
      kind: "gate", gate: "swap", pass: verdict.pass, strategy: "manual",
      reason: `cycle ${route.poolIds.join(">")}: ${verdict.reason}`,
      expectedOut: verified.expectedOut, guaranteedOut: verified.guaranteedOut,
      netPct: verdict.exactNetPct, exactness: verified.exactness,
      verifyMs: Date.now() - t0, leefUsd: book.leefUsd, waxUsd: book.waxUsd,
    });
    if (!verdict.pass) {
      throw new Error(`Round trip refused — ${verdict.reason}`);
    }
    route = { ...route, amountOut: verified.expectedOut };
    // Cycles verify leg-by-leg, so verified[0].alcor is a LEG-scoped quote —
    // never a whole-route quote. Never hand it to the signer as preQuoted;
    // the signer re-verifies cycles leg-by-leg itself.
    preQuoted = undefined;
  }

  const governed = governTrade(book, w.balances(), {
    tokenIn: opts.tokenIn,
    tokenOut: opts.tokenOut,
    amountIn: opts.amountIn,
    expectedOut: route.amountOut,
    // Manual swaps are explicit user intent, but still need an economically
    // non-destructive route. Positive output delta is not a profit forecast;
    // classify this as portfolio maintenance so reserves/concentration govern.
    expectedNetProfitUsd: 0,
    kind: "rebalance",
    route,
  });
  if (!governed.allowed || governed.allowedAmountIn + 1e-12 < opts.amountIn) {
    throw new Error(
      governed.allowed
        ? `Portfolio reserve allows only ${governed.allowedAmountIn.toFixed(8)} ${opts.tokenIn}`
        : `Portfolio governor: ${governed.reason}`,
    );
  }

  // Depth guard: never push an oversized position through an undersized
  // pool. The router already split across books when that paid (the winning
  // route may BE a split) — so if the best executable route still moves the
  // market this much, the right trade is a smaller one or none at all.
  const impactPct = route.priceImpact * 100;
  if (impactPct > MAX_SWAP_IMPACT_PCT) {
    throw new Error(
      `Too big for this book — ${impactPct.toFixed(1)}% price impact even after pool splitting. Try a smaller amount.`,
    );
  }

  const slices = splitSlices(route);
  if (w.canSign()) {
    if (slices) {
      const legs: BatchLeg[] = [];
      let expectedOut = 0;
      let guaranteedOut = 0;
      for (const sl of slices) {
        const tin = metaOf(sl.tokenIn, book);
        const tout = metaOf(sl.tokenOut, book);
        const quote = await fetchAlcorRouteCached({
          tokenInId: tin.alcorId,
          tokenOutId: tout.alcorId,
          amount: sl.amountIn,
          slippagePct: opts.slippage,
          receiver: w.account,
          decimalsIn: tin.decimals,
        });
        expectedOut += parseAssetAmount(quote.output);
        guaranteedOut += parseAssetAmount(quote.minReceived) || parseAssetAmount(quote.output) * (1 - opts.slippage / 100);
        for (const s of quote.swaps) {
          legs.push({
            contract: tin.contract,
            quantity: s.input,
            memo: s.memo,
          });
        }
      }
      // One fee per TRADE — a split is one trade. Charged once on the summed
      // guaranteed output, in the output token, inside the same atomic tx.
      const fee = platformFeeOn(guaranteedOut, metaOf(opts.tokenOut, book));
      if (fee) {
        legs.push({
          contract: fee.token.contract,
          quantity: fee.quantity,
          memo: PLATFORM_FEE_MEMO,
          to: fee.recipient,
        });
      }
      if (legs.length > MAX_MANUAL_SWAP_ACTIONS) {
        throw new Error(
          `This split expands to ${legs.length} on-chain actions — over the per-transaction CPU budget (max ${MAX_MANUAL_SWAP_ACTIONS}). Pin a simpler route above or use a smaller size.`,
        );
      }
      const coordinated = await coordinateCapitalMovement({
        owner: "manual",
        submit: () =>
          signAndPushBatch({
            account: w.account,
            permission: w.permission,
            legs,
            snap: book,
          }),
      });
      const { txid, reconciliation: rec } = coordinated;
      if (rec.status === "failed") throw new Error(rec.error);
      let amountOut = expectedOut;
      if (rec.status === "confirmed") {
        const outMeta = metaOf(opts.tokenOut, book);
        const actual = assetDelta(rec.transfers, w.account, outMeta.symbol, outMeta.contract);
        if (actual > 0) amountOut = actual;
      }
      journal({
        kind: "execution", action: "swap", strategy: "manual", mode: "live",
        tokenIn: opts.tokenIn, tokenOut: opts.tokenOut, amountIn: opts.amountIn,
        expectedOut, actualOut: amountOut, txid,
        status: rec.status === "confirmed" ? "confirmed" : "unknown",
        leefUsd: book.leefUsd, waxUsd: book.waxUsd,
      });
      return {
        mode: "live",
        amountOut,
        routeLabel: route.label,
        txid,
        confirmed: rec.status === "confirmed",
      };
    }
    const coordinated = await coordinateCapitalMovement({
      owner: "manual",
      submit: () =>
        signAndPushSwap({
          account: w.account,
          permission: w.permission,
          route,
          amountIn: opts.amountIn,
          slippagePct: opts.slippage,
          snap: book,
          // A cycle signs the venue-verified memos, not a blind re-quote.
          preQuoted,
        }),
    });
    const exec = coordinated.value;
    // Reconcile against the chain: actual transfers are truth. UNKNOWN stays
    // globally locked and is never retried blindly.
    const rec = coordinated.reconciliation;
    if (rec.status === "failed") throw new Error(rec.error);
    let amountOut = exec.expectedOut;
    if (rec.status === "confirmed") {
        const outMeta = metaOf(opts.tokenOut, book);
      const actual = assetDelta(rec.transfers, w.account, outMeta.symbol, outMeta.contract);
      if (actual > 0) amountOut = actual;
    }
    journal({
      kind: "execution", action: "swap", strategy: "manual", mode: "live",
      tokenIn: opts.tokenIn, tokenOut: opts.tokenOut, amountIn: opts.amountIn,
      expectedOut: exec.expectedOut, actualOut: amountOut, txid: exec.txid,
      status: rec.status === "confirmed" ? "confirmed" : "unknown",
      leefUsd: book.leefUsd, waxUsd: book.waxUsd,
    });
    return {
      mode: "live",
      amountOut,
      routeLabel: route.label,
      txid: exec.txid,
      confirmed: rec.status === "confirmed",
    };
  }

  if (slices) {
    let out = 0;
    let guaranteed = 0;
    for (const sl of slices) {
      const sliceOut =
        route.legs.find((l) => l.poolId === sl.poolId && l.amountIn === sl.amountIn)?.amountOut ?? 0;
      const min = sliceOut * (1 - opts.slippage / 100);
      guaranteed += min;
      w.applyPaperFill(sl.tokenIn, sl.amountIn, sl.tokenOut, min);
      out += min;
    }
    const fee = platformFeeOn(guaranteed, metaOf(opts.tokenOut, book));
    if (fee) {
      out -= fee.amount;
      // Debit the fee out of the wallet (credit nothing — it left for the fee account).
      w.applyPaperFill(opts.tokenOut, fee.amount, opts.tokenOut, 0);
    }
    journal({
      kind: "execution", action: "swap", strategy: "manual", mode: "paper",
      tokenIn: opts.tokenIn, tokenOut: opts.tokenOut, amountIn: opts.amountIn,
      expectedOut: route.amountOut, actualOut: out, status: "paper",
      platformFeeAmount: fee?.amount, platformFeeToken: fee?.token.symbol,
      leefUsd: book.leefUsd, waxUsd: book.waxUsd,
    });
    return { mode: "paper", amountOut: out, routeLabel: route.label };
  }
  const minOut = route.amountOut * (1 - opts.slippage / 100);
  const feeSingle = platformFeeOn(minOut, metaOf(route.tokenOut, book));
  w.applyPaperFill(route.tokenIn, opts.amountIn, route.tokenOut, minOut - (feeSingle?.amount ?? 0));
  journal({
    kind: "execution", action: "swap", strategy: "manual", mode: "paper",
    tokenIn: opts.tokenIn, tokenOut: opts.tokenOut, amountIn: opts.amountIn,
    expectedOut: route.amountOut, actualOut: minOut, status: "paper",
    leefUsd: book.leefUsd, waxUsd: book.waxUsd,
  });
  return { mode: "paper", amountOut: minOut, routeLabel: route.label };
}
