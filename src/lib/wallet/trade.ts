import { compareAllRoutes } from "@/lib/leef/amm";
import type { LeefSnapshot } from "@/lib/leef/types";
import { signAndPushSwap } from "./sign";
import { useWallet } from "@/store/wallet";

export type SwapOutcome = {
  mode: "paper" | "live";
  amountOut: number;
  routeLabel: string;
  txid?: string;
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
  const route = compareAllRoutes(
    opts.snap.pools,
    opts.snap.aux,
    opts.amountIn,
    opts.tokenIn,
    opts.tokenOut,
  )[0];
  if (!route) throw new Error("No backed route for this pair and size");

  if (w.canSign()) {
    const exec = await signAndPushSwap({
      account: w.account,
      permission: w.permission,
      route,
      amountIn: opts.amountIn,
      slippagePct: opts.slippage,
      snap: opts.snap,
    });
    return {
      mode: "live",
      amountOut: exec.expectedOut,
      routeLabel: route.label,
      txid: exec.txid,
    };
  }

  const minOut = route.amountOut * (1 - opts.slippage / 100);
  w.applyPaperFill(route.tokenIn, opts.amountIn, route.tokenOut, minOut);
  return { mode: "paper", amountOut: minOut, routeLabel: route.label };
}
