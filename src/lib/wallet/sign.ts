import type { ArbPlan } from "@/lib/leef/bot-engine";
import type { LeefSnapshot, SwapRoute } from "@/lib/leef/types";
import { fetchAlcorRoute } from "./alcor-route";
import {
  packAddLiquid,
  packCollect,
  packSubLiquid,
  packTransaction,
  packedTransactionBody,
  packTransferData,
  signingDigest,
  transactionHeaderFromInfo,
  type AddLiquidData,
  type ChainInfo,
  type CollectData,
  type SubLiquidData,
  type TransferActionData,
} from "./antelope";
import { getChainInfo, pushSigned } from "./chain";
import { memoForRoute } from "./memo";
import { hasSecret, signDigest } from "./secret";
import { walletSession } from "./session";
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

/** An action in both worlds: plain fields for wallet UIs, packed bytes for the local signer. */
type ActionSpec = {
  contract: string;
  name: string;
  plain: Record<string, unknown>;
  dataBytes: Uint8Array;
};

async function dispatchActions(opts: {
  account: string;
  permission?: string;
  actions: ActionSpec[];
}): Promise<{ txid: string }> {
  // External wallet (Cloud Wallet / Anchor): the wallet builds, signs and
  // broadcasts — and prompts the user for each transaction.
  const sess = walletSession();
  if (sess) {
    const actor = String(sess.actor);
    const permission = String(sess.permission);
    const result = await sess.transact({
      actions: opts.actions.map((a) => ({
        account: a.contract,
        name: a.name,
        authorization: [{ actor, permission }],
        data: a.plain,
      })),
    });
    const response = (
      result as { response?: { transaction_id?: string; processed?: { id?: string } } }
    ).response;
    const txid = response?.transaction_id ?? response?.processed?.id;
    if (!txid) throw new Error("Wallet did not return a transaction id");
    return { txid };
  }

  if (!hasSecret()) throw new Error("Connect a wallet or import a session key first");

  const rawInfo = (await getChainInfo()) as ChainInfo;
  const header = transactionHeaderFromInfo(rawInfo, 90);
  if (typeof rawInfo.chain_id !== "string" || rawInfo.chain_id.length !== 64) {
    throw new Error("Chain info did not include a valid chain_id");
  }

  const packedTx = packTransaction({
    ...header,
    actions: opts.actions.map((a) => ({
      account: a.contract,
      name: a.name,
      actor: opts.account,
      permission: opts.permission ?? "active",
      dataBytes: a.dataBytes,
    })),
  });

  const digest = signingDigest(rawInfo.chain_id, packedTx);
  const signature = signDigest(digest);
  return await pushSigned(packedTransactionBody(packedTx, [signature]));
}

function transferSpec(contract: string, data: TransferActionData): ActionSpec {
  return {
    contract,
    name: "transfer",
    plain: { from: data.from, to: data.to, quantity: data.quantity, memo: data.memo },
    dataBytes: packTransferData(data),
  };
}

async function signAndPushTransfers(opts: {
  account: string;
  permission?: string;
  transfers: { contract: string; data: TransferActionData }[];
}): Promise<{ txid: string }> {
  // Wallet sessions sign as the wallet's own actor — normalize `from` to it.
  const sess = walletSession();
  const from = sess ? String(sess.actor) : opts.account;
  return await dispatchActions({
    account: from,
    permission: opts.permission,
    actions: opts.transfers.map((t) =>
      transferSpec(t.contract, { ...t.data, from }),
    ),
  });
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

export type BatchLeg = {
  /** Token contract to transfer from (e.g. "eosio.token"). */
  contract: string;
  /** Asset string, e.g. "10.00000000 WAX". */
  quantity: string;
  /** Ready swap.alcor memo from the Alcor router. */
  memo: string;
};

/**
 * Broadcast several independent swap transfers as ONE atomic transaction.
 * Used by the rebalancer: every leg spends tokens the wallet already holds,
 * and if any leg's min-out fails, the whole batch reverts.
 */
export async function signAndPushBatch(opts: {
  account: string;
  permission?: string;
  legs: BatchLeg[];
}): Promise<{ txid: string }> {
  if (opts.legs.length === 0) throw new Error("Nothing to execute");
  return await signAndPushTransfers({
    account: opts.account,
    permission: opts.permission,
    transfers: opts.legs.map((l) => ({
      contract: l.contract,
      data: {
        from: opts.account,
        to: ALCOR_SWAP_CONTRACT,
        quantity: l.quantity,
        memo: l.memo.replaceAll("<receiver>", opts.account),
      },
    })),
  });
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
  const plan = opts.plan;

  // Preferred path: execute the exact legs Alcor's router returned. The return
  // leg is often SPLIT across routes, so each split becomes its own transfer.
  if (plan.buyLegs?.length && plan.sellLegs?.length) {
    const transfers = [
      ...plan.buyLegs.map((l) => ({
        contract: waxMeta.contract,
        data: {
          from: opts.account,
          to: ALCOR_SWAP_CONTRACT,
          quantity: l.input,
          memo: l.memo,
        },
      })),
      ...plan.sellLegs.map((l) => ({
        contract: leefMeta.contract,
        data: {
          from: opts.account,
          to: ALCOR_SWAP_CONTRACT,
          quantity: l.input,
          memo: l.memo,
        },
      })),
    ];
    return await signAndPushTransfers({
      account: opts.account,
      permission: opts.permission,
      transfers,
    });
  }

  // Fallback: single-route memos from the local constant-product plan.
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
          quantity: formatAsset(plan.waxIn, waxMeta),
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

/* ------------------------------------------------------------------ */
/* Liquidity positions (Alcor AMM, full-range)                          */
/* ------------------------------------------------------------------ */

/**
 * Add liquidity: deposit both tokens, then addliquid.
 * Mirrors alcor-ui: transfer ×2 with memo "deposit" + addliquid action.
 */
export async function signAndPushAddLiquidity(opts: {
  account: string;
  permission?: string;
  poolId: number;
  tokenA: { contract: string; symbol: string; decimals: number };
  tokenB: { contract: string; symbol: string; decimals: number };
  amountA: number;
  amountB: number;
  tickLower: number;
  tickUpper: number;
  /** Slippage buffer for the min bounds, percent. */
  slippagePct: number;
}): Promise<{ txid: string }> {
  const owner = walletSession() ? String(walletSession()!.actor) : opts.account;
  const amountA = formatAsset(opts.amountA, opts.tokenA);
  const amountB = formatAsset(opts.amountB, opts.tokenB);
  const minA = formatAsset(opts.amountA * (1 - opts.slippagePct / 100), opts.tokenA);
  const minB = formatAsset(opts.amountB * (1 - opts.slippagePct / 100), opts.tokenB);

  const addData: AddLiquidData = {
    poolId: opts.poolId,
    owner,
    tokenADesired: amountA,
    tokenBDesired: amountB,
    tickLower: opts.tickLower,
    tickUpper: opts.tickUpper,
    tokenAMin: minA,
    tokenBMin: minB,
    deadline: 0,
  };

  return await dispatchActions({
    account: owner,
    permission: opts.permission,
    actions: [
      transferSpec(opts.tokenA.contract, {
        from: owner,
        to: ALCOR_SWAP_CONTRACT,
        quantity: amountA,
        memo: "deposit",
      }),
      transferSpec(opts.tokenB.contract, {
        from: owner,
        to: ALCOR_SWAP_CONTRACT,
        quantity: amountB,
        memo: "deposit",
      }),
      {
        contract: ALCOR_SWAP_CONTRACT,
        name: "addliquid",
        plain: { ...addData },
        dataBytes: packAddLiquid(addData),
      },
    ],
  });
}

/**
 * Remove liquidity: subliquid (+ collect everything at 100%).
 * Mirrors alcor-ui's removal flow on swap.alcor.
 */
export async function signAndPushRemoveLiquidity(opts: {
  account: string;
  permission?: string;
  poolId: number;
  tickLower: number;
  tickUpper: number;
  /** Position liquidity units to burn. */
  liquidity: bigint;
  collectAll: boolean;
  /** Token metas — used for the zero min-bounds and the collect caps. */
  tokenA: { symbol: string; decimals: number };
  tokenB: { symbol: string; decimals: number };
  /** Max bounds for the collect call — pool reserves work as safe caps. */
  tokenAMax: string;
  tokenBMax: string;
}): Promise<{ txid: string }> {
  const owner = walletSession() ? String(walletSession()!.actor) : opts.account;

  const subData: SubLiquidData = {
    poolId: opts.poolId,
    owner,
    liquidity: opts.liquidity,
    tickLower: opts.tickLower,
    tickUpper: opts.tickUpper,
    // Min bounds of zero — same as alcor-ui's removal.
    tokenAMin: formatAsset(0, opts.tokenA),
    tokenBMin: formatAsset(0, opts.tokenB),
    deadline: 0,
  };
  const collectData: CollectData = {
    poolId: opts.poolId,
    owner,
    recipient: owner,
    tickLower: opts.tickLower,
    tickUpper: opts.tickUpper,
    tokenAMax: opts.tokenAMax,
    tokenBMax: opts.tokenBMax,
  };

  const actions: ActionSpec[] = [
    {
      contract: ALCOR_SWAP_CONTRACT,
      name: "subliquid",
      plain: { ...subData, liquidity: String(opts.liquidity) },
      dataBytes: packSubLiquid(subData),
    },
  ];
  if (opts.collectAll) {
    actions.push({
      contract: ALCOR_SWAP_CONTRACT,
      name: "collect",
      plain: { ...collectData },
      dataBytes: packCollect(collectData),
    });
  }
  return await dispatchActions({
    account: owner,
    permission: opts.permission,
    actions,
  });
}
