import type { ArbPlan } from "@/lib/leef/bot-engine";
import type { LeefSnapshot, SwapRoute } from "@/lib/leef/types";
import { fetchAlcorRoute } from "./alcor-route";
import {
  packTransaction,
  packedTransactionBody,
  signingDigest,
  transactionHeaderFromInfo,
  type ChainInfo,
  type TransferActionData,
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

async function signAndPushTransfers(opts: {
  account: string;
  permission?: string;
  transfers: { contract: string; data: TransferActionData }[];
}): Promise<{ txid: string }> {
  if (!hasSecret()) throw new Error("Import a private key in this tab first");

  const rawInfo = (await getChainInfo()) as ChainInfo;
  const header = transactionHeaderFromInfo(rawInfo, 90);
  if (typeof rawInfo.chain_id !== "string" || rawInfo.chain_id.length !== 64) {
    throw new Error("Chain info did not include a valid chain_id");
  }

  const packedTx = packTransaction({
    ...header,
    actions: opts.transfers.map((t) => ({
      account: t.contract,
      name: "transfer",
      actor: opts.account,
      permission: opts.permission ?? "active",
      data: t.data,
    })),
  });

  const digest = signingDigest(rawInfo.chain_id, packedTx);
  const signature = signDigest(digest);
  return await pushSigned(packedTransactionBody(packedTx, [signature]));
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
  /** Permission the session key authorizes on the account. */
  permission?: string;
  route: SwapRoute;
  amountIn: number;
  slippagePct: number;
  snap: LeefSnapshot;
}): Promise<SwapExecution> {
  const tokenIn = metaOf(opts.route.tokenIn, opts.snap);
  const { transfers, expectedOut, source } = await buildTransfers(opts);
  const { txid } = await signAndPushTransfers({
    account: opts.account,
    permission: opts.permission,
    transfers: transfers.map((t) => ({
      contract: tokenIn.contract,
      data: {
        from: opts.account,
        to: ALCOR_SWAP_CONTRACT,
        quantity: t.quantity,
        memo: t.memo,
      },
    })),
  });
  return { txid, expectedOut, routeSource: source };
}

/**
 * Atomic two-leg arbitrage in a single WAX transaction:
 *
 *   1. transfer WAX → swap.alcor   (buy LEEF on the cheap pool, min-out guard)
 *   2. transfer LEEF → swap.alcor  (sell it on the rich pool, min-out = profit floor)
 *
 * Actions run sequentially inside one transaction, so leg 2 spends the LEEF
 * leg 1 just bought. If either min-out fails, the WHOLE transaction reverts
 * and the wallet never moves — the arb either pays at least minProfitPct or
 * costs nothing but the (tiny) CPU of a failed tx.
 */
export async function signAndPushArb(opts: {
  account: string;
  permission?: string;
  plan: ArbPlan;
  /** Hard profit floor enforced on-chain for leg 2, percent. */
  minProfitPct: number;
  /** Leg-1 min-out buffer, percent. */
  slippagePct: number;
  snap: LeefSnapshot;
}): Promise<{ txid: string }> {
  const leefMeta = metaOf("LEEF", opts.snap);
  const waxMeta = metaOf("WAX", opts.snap);
  const leefMin = plan.leefMid * (1 - opts.slippagePct / 100);
  const waxFloor = plan.waxIn * (1 + opts.minProfitPct / 100);

  const leg1Memo = `swapexactin#${plan.buyPool.id}#${opts.account}#${formatAsset(leefMin, leefMeta).split(" ")[0]} ${leefMeta.symbol}@${leefMeta.contract}#0`;
  const leg2Memo = `swapexactin#${plan.sellPool.id}#${opts.account}#${formatAsset(waxFloor, waxMeta).split(" ")[0]} ${waxMeta.symbol}@${waxMeta.contract}#0`;

  return await signAndPushTransfers({
    account: opts.account,
    permission: opts.permission,
    transfers: [
      {
        contract: waxMeta.contract,
        data: {
          from: opts.account,
          to: ALCOR_SWAP_CONTRACT,
          quantity: formatAsset(opts.plan.waxIn, waxMeta),
          memo: leg1Memo,
        },
      },
      {
        contract: leefMeta.contract,
        data: {
          from: opts.account,
          to: ALCOR_SWAP_CONTRACT,
          quantity: formatAsset(leefMin, leefMeta),
          memo: leg2Memo,
        },
      },
    ],
  });
}
