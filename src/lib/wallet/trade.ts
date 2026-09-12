import { bestExecutionRoute, splitSlices } from "@/lib/leef/route-optimizer";
import { refreshExecutionState } from "@/lib/market/execution-state";
import { governTrade } from "@/lib/market/portfolio-governor";
import type { LeefSnapshot } from "@/lib/leef/types";
import { assetDelta, waitForTransaction } from "./reconcile";
import { signAndPushBatch, signAndPushSwap, type BatchLeg } from "./sign";
import { metaOf } from "./tokens";
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
 * Execute one swap from the Quotes desk (or anywhere) — paper fill on the
 * simulated book when no signer is connected, live on-chain otherwise.
 */
export async function executeSwap(opts: {
  snap: LeefSnapshot;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  slippage: number;
}): Promise<SwapOutcome> {
  if (!(opts.amountIn > 0)) throw new Error("Enter an amount first");
  if (opts.tokenIn.toUpperCase() === opts.tokenOut.toUpperCase()) {
    throw new Error("Pick two different tokens");
  }
  const w = useWallet.getState();
  const have = w.balances()[opts.tokenIn.toUpperCase()] ?? 0;
  if (have < opts.amountIn) {
    throw new Error(
      `Need ${opts.amountIn} ${opts.tokenIn.toUpperCase()}, wallet has ${have.toFixed(4)}`,
    );
  }
  // Size-specific route from the engine cache, then refresh ONLY its critical
  // pools when stale. The signer still obtains the final executable quote.
  let book = opts.snap;
  let route = bestExecutionRoute(
    book.pools,
    book.aux,
    opts.amountIn,
    opts.tokenIn,
    opts.tokenOut,
  );
  if (!route) throw new Error("No backed route for this pair and size");
  if (opts.snap.source === "live") {
    const exec = await refreshExecutionState(opts.snap, route);
    book = exec.snap;
    route = bestExecutionRoute(
      book.pools,
      book.aux,
      opts.amountIn,
      opts.tokenIn,
      opts.tokenOut,
    );
    if (!route) throw new Error("Route disappeared after critical-pool refresh");
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
      const { txid } = await signAndPushBatch({
        account: w.account,
        permission: w.permission,
        legs,
        snap: book,
      });
      const rec = await waitForTransaction(txid, { budgetMs: 1_200, attempts: 3, delayMs: 200 });
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
    const exec = await signAndPushSwap({
      account: w.account,
      permission: w.permission,
      route,
      amountIn: opts.amountIn,
      slippagePct: opts.slippage,
      snap: book,
    });
    // Reconcile against the chain: the actual transfer is the truth, the
    // router quote is only an estimate. On "unknown" we return the estimate
    // and never retry blindly — the next wallet sync corrects balances.
    const rec = await waitForTransaction(exec.txid, { budgetMs: 1_200, attempts: 3, delayMs: 200 });
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
