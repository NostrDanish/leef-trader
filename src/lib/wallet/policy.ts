/**
 * Transaction policy firewall.
 *
 * Every action this app ever signs — session key, Cloud Wallet or Anchor —
 * passes through `assertActionPolicy` BEFORE a signer sees it. The signer is
 * never a generic "sign anything" primitive: an action is only allowed when
 * it is structurally exactly what the trading desks intend:
 *
 *  - token `transfer` to the Alcor AMM (`swap.alcor`), from the signing
 *    account, with a quantity whose symbol, contract AND precision match the
 *    verified token catalog, and a memo that is either an LP `deposit` or a
 *    well-formed `swapexactin#…` route paying out to the signing account;
 *  - `addliquid` / `subliquid` / `collect` on `swap.alcor`, owned by (and
 *    paying to) the signing account.
 *
 * Anything else — unknown contracts, unknown actions, spoofed token
 * contracts, foreign receivers, malformed memos — is rejected, so a UI or
 * strategy bug can never turn into an arbitrary on-chain action.
 *
 * `arbFloorViolation` enforces the second hard invariant: an atomic arb is
 * only signed when the sell legs' ON-CHAIN min-outs (what the chain actually
 * guarantees) sum to at least `waxIn × (1 + minProfitPct)`. Quoted profit is
 * not proof — the memo min-outs are.
 */
import { LEEF_CONTRACT, LEEF_SYMBOL, WAX_CONTRACT, WAX_SYMBOL } from "@/lib/leef/types";
import type { LeefSnapshot } from "@/lib/leef/types";
import {
  PLATFORM_FEE_ACCOUNT,
  PLATFORM_FEE_MEMO,
} from "@/lib/leef/platform-fee";
import { DEFIBOX_SWAP, TACO_SWAP } from "@/lib/leef/venues";
import { isAccountName, parseAsset, tokenCatalog } from "./tokens";

/** Alcor's on-chain AMM contract on WAX. Swaps execute as token transfers into it. */
export const ALCOR_SWAP_CONTRACT = "swap.alcor";
const ALLOWED_SWAP_TO = new Set([ALCOR_SWAP_CONTRACT, DEFIBOX_SWAP, TACO_SWAP]);

/** The only actions this app may ever call on the AMM contract itself. */
const ALCOR_AMM_ACTIONS = new Set(["addliquid", "subliquid", "collect"]);

/** System contract for resource staking (CPU/NET). Self-stake only. */
const EOSIO_SYSTEM = "eosio";
const EOSIO_ACTIONS = new Set(["delegatebw"]);

/** Minimal token identity the policy needs — symbol + contract + precision. */
export type PolicyToken = { symbol: string; contract: string; decimals: number };

export type PolicyAction = {
  contract: string;
  name: string;
  /** Plain action data (from/to/quantity/memo for transfers). */
  plain: Record<string, unknown>;
};

export type PolicyContext = {
  /** Snapshot-derived catalog (LEEF pools, aux pools, token universe). */
  snap?: Pick<LeefSnapshot, "pools" | "aux" | "universe">;
  /** Extra tokens the caller vouches for (e.g. the two sides of an LP pool). */
  extraTokens?: PolicyToken[];
  /**
   * Platform-fee transfers present in this action list: max allowed amount
   * per "SYMBOL@contract". The recipient is NOT read from here — the rule
   * checks the compile-time constant directly, so no caller, quote, API
   * response or AI can redirect the fee.
   */
  platformFee?: { maxByKey: Record<string, number> };
};

/** One parsed `swapexactin#<pools>#<receiver>#<minOut SYM@contract>#<flags>` memo. */
export type SwapMemo = {
  poolIds: number[];
  receiver: string;
  minAmount: number;
  minSymbol: string;
  minContract: string;
};

/**
 * Canonical symbol → token map for policy checks. Base tokens (WAX, LEEF, …)
 * are inserted first and can never be overridden by pool/universe data, so a
 * spoofed "LEEF" on a foreign contract can never displace leefmaincorp.
 */
function policyTokens(ctx?: PolicyContext): Map<string, PolicyToken> {
  const map = new Map<string, PolicyToken>();
  const put = (t: PolicyToken) => {
    if (!t.symbol || !t.contract) return;
    const key = t.symbol.toUpperCase();
    if (!map.has(key)) {
      map.set(key, { symbol: key, contract: t.contract, decimals: t.decimals });
    }
  };
  for (const t of tokenCatalog(ctx?.snap)) put(t); // BASE first — authoritative
  for (const p of ctx?.snap?.aux ?? []) {
    put(p.tokenA);
    put(p.tokenB);
  }
  for (const u of ctx?.snap?.universe ?? []) put(u);
  for (const t of ctx?.extraTokens ?? []) put(t);
  return map;
}

/**
 * Parse and structurally validate a swap.alcor memo. The `<receiver>`
 * placeholder is normalized against the expected account first. Returns null
 * on ANY deviation — a memo we can't fully understand is never signed.
 */
export function parseSwapMemo(raw: string, account: string): SwapMemo | null {
  const memo = raw.replaceAll("<receiver>", account).trim();
  const parts = memo.split("#");
  if (parts.length !== 5) return null;
  const [tag, poolsRaw, receiver, minRaw, flags] = parts;
  if (tag !== "swapexactin") return null;
  const poolIds = (poolsRaw ?? "").split(",").map((p) => Number(p));
  if (poolIds.length === 0 || poolIds.some((n) => !Number.isInteger(n) || n < 0)) return null;
  if (receiver !== account) return null;
  const m = (minRaw ?? "").trim().match(/^(\d+(?:\.\d+)?)\s+([A-Z0-9]+)@([a-z1-5.]{1,13})$/);
  if (!m) return null;
  const minAmount = Number(m[1]);
  if (!Number.isFinite(minAmount) || minAmount < 0) return null;
  if (!/^\d+$/.test(flags ?? "")) return null;
  return { poolIds, receiver, minAmount, minSymbol: m[2]!, minContract: m[3]! };
}

function fail(reason: string): never {
  throw new Error(`Transaction policy: ${reason}`);
}

function checkTransfer(
  action: PolicyAction,
  account: string,
  tokens: Map<string, PolicyToken>,
  feeCtx?: { maxByKey: Record<string, number> },
): void {
  const from = String(action.plain.from ?? "");
  const to = String(action.plain.to ?? "");
  const quantity = String(action.plain.quantity ?? "");
  const memo = String(action.plain.memo ?? "");

  if (from !== account) fail(`transfer from "${from}" but the signer is "${account}"`);

  // Platform fee: a transfer to the canonical fee account with the canonical
  // memo, a known token at the right contract+precision, and an amount within
  // the caller-vouched bound. Anything else to a non-AMM is rejected below.
  if (to === PLATFORM_FEE_ACCOUNT) {
    if (memo !== PLATFORM_FEE_MEMO) fail("fee transfer must carry the canonical fee memo");
    const asset = parseAsset(quantity);
    if (!asset || !(asset.amount > 0)) fail(`bad fee quantity "${quantity}"`);
    const known = tokens.get(asset!.symbol);
    if (!known) fail(`unknown fee token ${asset!.symbol}`);
    if (known!.contract !== action.contract) {
      fail(`fee token ${asset!.symbol} lives at ${known!.contract}, not ${action.contract}`);
    }
    const frac = quantity.trim().split(/\s+/)[0]?.split(".")[1] ?? "";
    if (frac.length !== known!.decimals) fail(`fee precision mismatch for ${asset!.symbol}`);
    const max = feeCtx?.maxByKey[`${asset!.symbol}@${action.contract}`];
    if (max == null) fail("fee transfer without a platform-fee policy context");
    if (asset!.amount > max + 1e-12) {
      fail(`fee ${asset!.amount} exceeds the vouched maximum ${max}`);
    }
    return;
  }

  if (!ALLOWED_SWAP_TO.has(to)) {
    fail(`transfers may only go to allowlisted AMMs, not "${to}"`);
  }
  const asset = parseAsset(quantity);
  if (!asset || !(asset.amount > 0)) fail(`bad quantity "${quantity}"`);
  const known = tokens.get(asset!.symbol);
  if (!known) fail(`unknown token ${asset!.symbol} — refusing to transfer it`);
  if (known!.contract !== action.contract) {
    fail(
      `${asset!.symbol} lives at ${known!.contract}, not ${action.contract} — possible spoof`,
    );
  }
  // The asset string's precision must match the catalog's verified precision.
  const frac = quantity.trim().split(/\s+/)[0]?.split(".")[1] ?? "";
  if (frac.length !== known!.decimals) {
    fail(
      `${asset!.symbol} precision ${frac.length} doesn't match the catalog's ${known!.decimals}`,
    );
  }

  if (memo.trim() === "deposit") return; // LP deposit leg
  if (to === DEFIBOX_SWAP) {
    if (!/^swap,\d+,\d+$/.test(memo.trim())) {
      fail("Defibox memo must be swap,<min_out_units>,<pair_id>");
    }
    return;
  }
  if (to === TACO_SWAP) {
    const m = memo.trim().match(/^(\d+(?:\.\d+)?)\s+([A-Z0-9]+)@([a-z1-5.]{1,13})$/);
    if (!m) fail("Taco memo must be `<min> SYM@contract`");
    const minToken = tokens.get(m[2]!);
    if (!minToken || minToken.contract !== m[3]) {
      fail(`Taco min-out ${m[2]}@${m[3]} isn't the verified token for that symbol`);
    }
    return;
  }
  const swap = parseSwapMemo(memo, account);
  if (!swap) {
    fail("transfer memo is neither an LP deposit nor a valid swapexactin route to this account");
  }
  const minToken = tokens.get(swap!.minSymbol);
  if (!minToken || minToken.contract !== swap!.minContract) {
    fail(
      `swap min-out ${swap!.minSymbol}@${swap!.minContract} isn't the verified token for that symbol`,
    );
  }
}

/**
 * Validate a whole action list against the trading policy. Throws with a
 * precise reason on the first violation; returns void when every action is
 * an allowed, well-formed trading action.
 */
export function assertActionPolicy(
  actions: PolicyAction[],
  account: string,
  ctx?: PolicyContext,
): void {
  if (!isAccountName(account)) fail(`"${account}" is not a valid WAX account name`);
  if (actions.length === 0) fail("nothing to execute");
  const tokens = policyTokens(ctx);
  for (const action of actions) {
    if (action.contract === ALCOR_SWAP_CONTRACT) {
      if (!ALCOR_AMM_ACTIONS.has(action.name)) {
        fail(`action ${action.name} on ${ALCOR_SWAP_CONTRACT} is not allowed`);
      }
      const owner = String(action.plain.owner ?? "");
      if (owner && owner !== account) fail(`${action.name} owner "${owner}" ≠ signer`);
      const recipient = String(action.plain.recipient ?? "");
      if (recipient && recipient !== account) fail(`${action.name} pays "${recipient}" ≠ signer`);
      continue;
    }
    // Resource staking: only self-delegatebw with plain WAX quantities.
    // `transfer: true` would GIVE the stake away — never allowed.
    if (action.contract === EOSIO_SYSTEM) {
      if (!EOSIO_ACTIONS.has(action.name)) {
        fail(`action ${action.name} on ${EOSIO_SYSTEM} is not allowed`);
      }
      const from = String(action.plain.from ?? "");
      const receiver = String(action.plain.receiver ?? "");
      if (from !== account || receiver !== account) {
        fail("delegatebw may only stake from and to the signing account");
      }
      if (action.plain.transfer === true) fail("delegatebw with transfer=true gives away the stake");
      for (const field of ["stake_net_quantity", "stake_cpu_quantity"] as const) {
        const q = String(action.plain[field] ?? "");
        const asset = parseAsset(q);
        if (!asset) fail(`bad ${field} "${q}"`);
        if (asset!.symbol !== "WAX") fail(`delegatebw must stake WAX, not ${asset!.symbol}`);
        const frac = q.trim().split(/\s+/)[0]?.split(".")[1] ?? "";
        if (frac.length !== 8) fail(`WAX stake precision must be 8 decimals, got ${frac.length}`);
      }
      continue;
    }
    if (action.name !== "transfer") {
      fail(`only token transfers + AMM liquidity actions are allowed — got ${action.contract}::${action.name}`);
    }
    checkTransfer(action, account, tokens, ctx?.platformFee);
  }
}

/* ------------------------------------------------------------------ */
/* Atomic-arb profit floor                                             */
/* ------------------------------------------------------------------ */

/** Structural view of a router leg — what the floor check needs. */
export type ArbLegLike = { input: string; memo: string };

/**
 * Verify the transaction-level arb invariant against the actual router legs:
 *
 *   Σ sell-leg min-outs  ≥  (Σ buy-leg inputs) × (1 + minProfitPct)
 *
 * where the min-outs are what the swap.alcor contract enforces on-chain.
 * Quoted output is NOT proof: a router quote with a slippage band can dip
 * below the configured floor, and this check is what catches that before a
 * signature exists. Returns null when the invariant holds, else the reason.
 */
export function arbFloorViolation(opts: {
  waxIn: number;
  minProfitPct: number;
  buyLegs: ArbLegLike[];
  sellLegs: ArbLegLike[];
  account: string;
}): string | null {
  const { waxIn, minProfitPct, buyLegs, sellLegs, account } = opts;
  if (!(waxIn > 0)) return "arb size must be positive";
  if (buyLegs.length === 0 || sellLegs.length === 0) {
    return "arb needs fresh Alcor router legs for both sides";
  }

  let buyIn = 0;
  for (const leg of buyLegs) {
    const input = parseAsset(leg.input);
    if (!input || input.symbol !== WAX_SYMBOL || !(input.amount > 0)) {
      return `buy leg input isn't a WAX amount: "${leg.input}"`;
    }
    const memo = parseSwapMemo(leg.memo, account);
    if (!memo) return "buy leg memo failed validation (pools/receiver/min-out)";
    if (memo.minSymbol !== LEEF_SYMBOL || memo.minContract !== LEEF_CONTRACT) {
      return `buy leg min-out isn't ${LEEF_SYMBOL}@${LEEF_CONTRACT}`;
    }
    buyIn += input.amount;
  }
  // Router splits must never pull MORE than the risk-sized clip. (Less is
  // fine — the floor below scales to the actual spend.)
  if (buyIn > waxIn * 1.0001) {
    return `router wants to pull ${buyIn.toFixed(8)} WAX but the plan sized ${waxIn.toFixed(8)} WAX`;
  }

  let minWaxOut = 0;
  for (const leg of sellLegs) {
    const input = parseAsset(leg.input);
    if (!input || input.symbol !== LEEF_SYMBOL || !(input.amount > 0)) {
      return `sell leg input isn't a LEEF amount: "${leg.input}"`;
    }
    const memo = parseSwapMemo(leg.memo, account);
    if (!memo) return "sell leg memo failed validation (pools/receiver/min-out)";
    if (memo.minSymbol !== WAX_SYMBOL || memo.minContract !== WAX_CONTRACT) {
      return `sell leg min-out isn't ${WAX_SYMBOL}@${WAX_CONTRACT}`;
    }
    minWaxOut += memo.minAmount;
  }

  const floor = buyIn * (1 + minProfitPct / 100);
  // One WAX quantum (1e-8) of slack: 10 * 1.012 is 10.120000000000001 in
  // IEEE-754 — an exactly-at-floor min-out must pass, not die to float dust.
  if (minWaxOut + 1e-8 < floor) {
    return (
      `route no longer clears the profit floor — enforced min-out ${minWaxOut.toFixed(8)} WAX ` +
      `< required ${floor.toFixed(8)} WAX (${minProfitPct}% over ${buyIn.toFixed(4)} WAX in)`
    );
  }
  return null;
}

/** Sum the on-chain-enforced min-outs of router legs (0 for unparseable legs). */
export function memoMinOutSum(legs: ArbLegLike[], account: string): number {
  let sum = 0;
  for (const leg of legs) {
    sum += parseSwapMemo(leg.memo, account)?.minAmount ?? 0;
  }
  return sum;
}
