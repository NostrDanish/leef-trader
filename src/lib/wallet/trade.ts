import { rankExecutionRoutes, routeSignature, splitSlices } from "@/lib/leef/route-optimizer";
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
import { parseAssetAmount } from "./alcor-route";
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
  if (opts.tokenIn.toUpperCase() === opts.tokenOut.toUpperCase()) {
    throw new Error("Pick two different tokens");
  }
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
        : "No backed route for this pair and size",
    );
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
        for (const s of quote.swaps) {
          legs.push({
            contract: tin.contract,
            quantity: s.input,
            memo: s.memo,
          });
        }
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
    for (const sl of slices) {
      const sliceOut =
        route.legs.find((l) => l.poolId === sl.poolId && l.amountIn === sl.amountIn)?.amountOut ?? 0;
      const min = sliceOut * (1 - opts.slippage / 100);
      w.applyPaperFill(sl.tokenIn, sl.amountIn, sl.tokenOut, min);
      out += min;
    }
    return { mode: "paper", amountOut: out, routeLabel: route.label };
  }
  const minOut = route.amountOut * (1 - opts.slippage / 100);
  w.applyPaperFill(route.tokenIn, opts.amountIn, route.tokenOut, minOut);
  return { mode: "paper", amountOut: minOut, routeLabel: route.label };
}
