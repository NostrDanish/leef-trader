import { bestExecutionRoute, splitSlices } from "@/lib/leef/route-optimizer";
import { getLeefSnapshot } from "@/lib/leef/snapshot";
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
  // Fresh book, then size-specific route. Live still requotes Alcor CLMM
  // immediately before sign (executable truth).
  let book = opts.snap;
  if (opts.snap.source === "live") {
    try {
      const latest = await getLeefSnapshot();
      if (latest.source === "live") book = latest;
    } catch {
      /* keep the desk snapshot */
    }
  }
  const route = bestExecutionRoute(
    book.pools,
    book.aux,
    opts.amountIn,
    opts.tokenIn,
    opts.tokenOut,
  );
  if (!route) throw new Error("No backed route for this pair and size");

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
