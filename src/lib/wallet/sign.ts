import type { ArbPlan } from "@/lib/leef/bot-engine";
import type { LeefSnapshot, SwapRoute } from "@/lib/leef/types";
import { LEEF_CONTRACT, WAX_CONTRACT } from "@/lib/leef/types";
import { swapContractOf, venueOfPoolId } from "@/lib/leef/venues";
import { verifyExecutableRoute } from "@/lib/leef/quote-verify";
import { TradeError } from "./trade-error";
import { fetchAlcorRoute, parseAssetAmount } from "./alcor-route";
import {
  packAddLiquid,
  packCollect,
  packSubLiquid,
  packTransaction,
  packedTransactionBody,
  packTransferData,
  signingDigest,
  transactionIdOf,
  transactionHeaderFromInfo,
  type AddLiquidData,
  type ChainInfo,
  type CollectData,
  type SubLiquidData,
  type TransferActionData,
} from "./antelope";
import { BroadcastTimeoutError, getChainInfo, pushSigned } from "./chain";
import { reconcileTransfersLater } from "./reconcile";
import { markConfirmed, markFailed, markUnknown } from "./trade-cycle";
import {
  ALCOR_SWAP_CONTRACT,
  arbFloorViolation,
  assertActionPolicy,
  type PolicyContext,
} from "./policy";
import { hasSecret, signDigest } from "./secret";
import { walletSession } from "./session";
import { formatAsset, parseAsset, metaOf } from "./tokens";

export { ALCOR_SWAP_CONTRACT };

type TransferSpec = { tokenContract: string; to: string; quantity: string; memo: string };

export type SwapExecution = {
  txid: string;
  /** Total expected output in tokenOut units (router quote — see note in trade.ts). */
  expectedOut: number;
};

function allAlcor(route: SwapRoute): boolean {
  return route.legs.every((l) => (l.venue ?? venueOfPoolId(l.poolId)) === "alcor");
}

/**
 * Alcor-only routes still requote through Alcor's CLMM router (executable
 * truth). Defibox/Taco legs use on-chain CP min-out memos — there is no
 * equivalent public router. Mixed routes are sequential transfers in one tx.
 */
async function buildTransfers(opts: {
  account: string;
  route: SwapRoute;
  amountIn: number;
  slippagePct: number;
  snap: LeefSnapshot;
}): Promise<{ transfers: TransferSpec[]; expectedOut: number }> {
  const tokenIn = metaOf(opts.route.tokenIn, opts.snap);
  const tokenOut = metaOf(opts.route.tokenOut, opts.snap);

  if (allAlcor(opts.route)) {
    // Fresh (uncached) quote at sign time — a cached memo can carry a min-out
    // the market no longer clears, which the chain reverts.
    const quote = await fetchAlcorRoute({
      tokenInId: tokenIn.alcorId,
      tokenOutId: tokenOut.alcorId,
      amount: opts.amountIn,
      slippagePct: opts.slippagePct,
      receiver: opts.account,
      maxHops: Math.min(10, Math.max(2, opts.route.legs.length)),
    });
    const transfers = quote.swaps.map((s) => ({
      tokenContract: tokenIn.contract,
      to: ALCOR_SWAP_CONTRACT,
      quantity: s.input,
      memo: s.memo.replaceAll("<receiver>", opts.account),
    }));
    for (const t of transfers) {
      const a = parseAsset(t.quantity);
      if (!a || !(a.amount > 0)) {
        throw new TradeError("MIN_OUT_FAILED", `Invalid amount "${t.quantity}"`);
      }
    }
    const expectedOut = parseAssetAmount(quote.output) || opts.route.amountOut;
    const outScale = 10 ** tokenOut.decimals;
    if (Math.floor(expectedOut * outScale) <= 0) {
      throw new TradeError(
        "MIN_OUT_FAILED",
        `Output rounds to 0 ${tokenOut.symbol} — trade too small to execute`,
      );
    }
    return { transfers, expectedOut };
  }

  const verified = await verifyExecutableRoute({
    route: opts.route,
    amountIn: opts.amountIn,
    slippagePct: opts.slippagePct,
    account: opts.account,
    snap: opts.snap,
    deadlineMs: 4_000,
  });
  if (verified.trust !== "executable") {
    throw new TradeError("MODEL_ONLY", "Venue quote is model-only — not signing");
  }
  const transfers: TransferSpec[] = [];
  for (let i = 0; i < opts.route.legs.length; i++) {
    const leg = opts.route.legs[i]!;
    const v = verified.verified[i];
    const venue = leg.venue ?? venueOfPoolId(leg.poolId);
    const tin = metaOf(leg.tokenIn, opts.snap);
    if (venue === "alcor") {
      const quote = v?.alcor;
      if (!quote) {
        throw new TradeError("VENUE_UNAVAILABLE", "Alcor leg missing fresh quote");
      }
      for (const s of quote.swaps) {
        transfers.push({
          tokenContract: tin.contract,
          to: ALCOR_SWAP_CONTRACT,
          quantity: s.input,
          memo: s.memo.replaceAll("<receiver>", opts.account),
        });
      }
      continue;
    }
    const memo = v?.memo;
    if (!memo) {
      throw new TradeError("MODEL_ONLY", `${venue} leg has no fresh executable memo`);
    }
    transfers.push({
      tokenContract: tin.contract,
      to: swapContractOf(venue),
      quantity: formatAsset(v.amountIn, tin),
      memo,
    });
  }
  return { transfers, expectedOut: verified.expectedOut };
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
  policy?: PolicyContext;
}): Promise<{ txid: string }> {
  // Policy firewall: EVERY action list — session key, Cloud Wallet or Anchor —
  // is validated before a signer ever sees it. The signer is never asked to
  // sign an arbitrary transaction.
  assertActionPolicy(opts.actions, opts.account, opts.policy);

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

  // Transaction id is sha256(packed_trx) — known BEFORE broadcast, so a
  // network timeout can be reconciled by txid instead of guessed at.
  const txid = transactionIdOf(packedTx);
  const digest = signingDigest(rawInfo.chain_id, packedTx);
  const signature = signDigest(digest);
  try {
    return await pushSigned(packedTransactionBody(packedTx, [signature]));
  } catch (err) {
    if (err instanceof BroadcastTimeoutError) {
      // The node never answered — the transaction may still land. Lock the
      // capital as UNKNOWN with the known txid and let reconciliation decide.
      // NEVER re-sign, NEVER re-broadcast, NEVER duplicate-spend.
      markUnknown(txid);
      // Start reconciliation here, at the boundary where the txid is known.
      // The caller may classify/return the error, but this read-only poll keeps
      // running and is the only path that can unlock UNKNOWN capital.
      void reconcileTransfersLater(txid).then((rec) => {
        if (rec.status === "confirmed") markConfirmed();
        else if (rec.status === "failed") markFailed();
        // still unknown → stay locked; never submit another transaction
      });
      throw new TradeError(
        "TRANSACTION_UNKNOWN",
        `Broadcast timed out — tracking tx ${txid.slice(0, 10)}… on-chain; not resubmitting`,
      );
    }
    throw err;
  }
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
  policy?: PolicyContext;
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
    policy: opts.policy,
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
  const { transfers, expectedOut } = await buildTransfers(opts);
  const { txid } = await signAndPushTransfers({
    account: opts.account,
    permission: opts.permission,
    transfers: transfers.map((t) => ({
      contract: t.tokenContract,
      data: {
        from: opts.account,
        to: t.to,
        quantity: t.quantity,
        memo: t.memo,
      },
    })),
    policy: { snap: opts.snap },
  });
  return { txid, expectedOut };
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
  /** Snapshot the legs were planned against — feeds the policy token catalog. */
  snap: LeefSnapshot;
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
    policy: { snap: opts.snap },
  });
}

/**
 * Atomic two-leg arbitrage in a single WAX transaction:
 *
 *   1. transfer WAX → swap.alcor   (buy LEEF via the router's legs)
 *   2. transfer LEEF → swap.alcor  (sell it via the router's legs)
 *
 * Actions run sequentially inside one transaction, so leg 2 spends the LEEF
 * leg 1 just bought. If any leg's min-out fails, the WHOLE transaction
 * reverts and the wallet never moves.
 *
 * Two hard invariants are enforced BEFORE anything is signed:
 *
 *  - Router legs only. The local constant-product estimate is never turned
 *    into a live transaction — no legs, no trade.
 *  - Transaction-level profit floor: the sell legs' on-chain min-outs (what
 *    swap.alcor actually guarantees) must sum to at least
 *    waxIn × (1 + minProfitPct). A quoted profit with a slippage band that
 *    can dip below the floor is rejected here, at the signing boundary.
 */
export async function signAndPushArb(opts: {
  account: string;
  permission?: string;
  plan: ArbPlan;
  /** Hard profit floor the sell legs must enforce on-chain, percent. */
  minProfitPct: number;
  snap: LeefSnapshot;
}): Promise<{ txid: string }> {
  const plan = opts.plan;

  if (!plan.buyLegs?.length || !plan.sellLegs?.length) {
    throw new Error(
      "Live arb needs fresh Alcor router legs — the local estimate is never used for real execution",
    );
  }

  const violation = arbFloorViolation({
    waxIn: plan.waxIn,
    minProfitPct: opts.minProfitPct,
    buyLegs: plan.buyLegs,
    sellLegs: plan.sellLegs,
    account: opts.account,
  });
  if (violation) throw new Error(violation);

  const transfers = [
    ...plan.buyLegs.map((l) => ({
      contract: WAX_CONTRACT,
      data: {
        from: opts.account,
        to: ALCOR_SWAP_CONTRACT,
        quantity: l.input,
        memo: l.memo.replaceAll("<receiver>", opts.account),
      },
    })),
    ...plan.sellLegs.map((l) => ({
      contract: LEEF_CONTRACT,
      data: {
        from: opts.account,
        to: ALCOR_SWAP_CONTRACT,
        quantity: l.input,
        memo: l.memo.replaceAll("<receiver>", opts.account),
      },
    })),
  ];
  return await signAndPushTransfers({
    account: opts.account,
    permission: opts.permission,
    transfers,
    policy: { snap: opts.snap },
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
    policy: { extraTokens: [opts.tokenA, opts.tokenB] },
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
    policy: {},
  });
}
