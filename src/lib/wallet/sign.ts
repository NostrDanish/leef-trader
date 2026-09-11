import type { LeefSnapshot, SwapRoute } from "@/lib/leef/types";
import { fetchAlcorRoute } from "./alcor-route";
import {
  packTransaction,
  packedTransactionBody,
  signingDigest,
  transactionHeaderFromInfo,
  type ChainInfo,
} from "./antelope";
import { getChainInfo, pushSigned } from "./chain";
import { memoForRoute } from "./memo";
import { hasSecret, signDigest } from "./secret";
import { formatAsset, metaOf } from "./tokens";

/** Alcor's on-chain AMM contract on WAX. Swaps execute as token transfers into it. */
export const ALCOR_SWAP_CONTRACT = "swap.alcor";

type TransferSpec = { quantity: string; memo: string };

export type SwapExecution = {
  txid: string;
  /** Total expected output in tokenOut units. */
  expectedOut: number;
  /** Whether the memo came from Alcor's CLMM router or the local constant-product book. */
  routeSource: "alcor" | "local";
};

async function buildTransfers(opts: {
  account: string;
  route: SwapRoute;
  amountIn: number;
  slippagePct: number;
  snap: LeefSnapshot;
}): Promise<{ transfers: TransferSpec[]; expectedOut: number; source: "alcor" | "local" }> {
  const tokenIn = metaOf(opts.route.tokenIn, opts.snap);
  const tokenOut = metaOf(opts.route.tokenOut, opts.snap);

  try {
    const quote = await fetchAlcorRoute({
      tokenInId: tokenIn.alcorId,
      tokenOutId: tokenOut.alcorId,
      amount: opts.amountIn,
      slippagePct: opts.slippagePct,
      receiver: opts.account,
    });
    return {
      transfers: quote.swaps.map((s) => ({
        quantity: s.input,
        memo: s.memo.replaceAll("<receiver>", opts.account),
      })),
      expectedOut: Number(quote.output) || opts.route.amountOut,
      source: "alcor",
    };
  } catch {
    // Router offline or pair unrouted — fall back to our local constant-product
    // quote and hand-build the swap.alcor memo for the best route we found.
    const quantity = formatAsset(opts.amountIn, tokenIn);
    const memo = memoForRoute(opts.route, opts.account, opts.slippagePct, tokenOut);
    return {
      transfers: [{ quantity, memo }],
      expectedOut: opts.route.amountOut,
      source: "local",
    };
  }
}

/**
 * Sign and broadcast a swap on the WAX blockchain.
 *
 * Alcor's AMM executes swaps as plain token transfers to `swap.alcor` whose
 * memo encodes the pool route, receiver and minimum output — exactly how
 * alcor-ui submits them. The session key signs locally; only the signed
 * transaction leaves the browser.
 */
export async function signAndPushSwap(opts: {
  account: string;
  route: SwapRoute;
  amountIn: number;
  slippagePct: number;
  snap: LeefSnapshot;
}): Promise<SwapExecution> {
  if (!hasSecret()) throw new Error("Import a private key in this tab first");
  const tokenIn = metaOf(opts.route.tokenIn, opts.snap);
  const { transfers, expectedOut, source } = await buildTransfers(opts);

  const rawInfo = (await getChainInfo()) as ChainInfo;
  const header = transactionHeaderFromInfo(rawInfo, 90);
  if (typeof rawInfo.chain_id !== "string" || rawInfo.chain_id.length !== 64) {
    throw new Error("Chain info did not include a valid chain_id");
  }

  const packedTx = packTransaction({
    ...header,
    actions: transfers.map((t) => ({
      account: tokenIn.contract,
      name: "transfer",
      actor: opts.account,
      data: {
        from: opts.account,
        to: ALCOR_SWAP_CONTRACT,
        quantity: t.quantity,
        memo: t.memo,
      },
    })),
  });

  const digest = signingDigest(rawInfo.chain_id, packedTx);
  const signature = signDigest(digest);
  const { txid } = await pushSigned(packedTransactionBody(packedTx, [signature]));
  return { txid, expectedOut, routeSource: source };
}
