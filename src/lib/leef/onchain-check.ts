/**
 * Independent chain-truth bound for Alcor router quotes.
 *
 * For all-Alcor routes the expected output, `minReceived` AND the memos all
 * come from one HTTP response (wax.alcor.exchange swapRouter). The firewall
 * then compares the memo min-outs against `expectedOut` from that SAME
 * response — so a compromised or buggy router that returns a low output with
 * matching low min-outs passes every check.
 *
 * This module reads the memo's pools straight from the `swap.alcor` table via
 * the health-scored RPC pool (NOT the Alcor API) and computes a no-impact
 * spot bound along each leg:
 *
 *   spotOut = Σ_splits  input × Π_legs (spot price × (1 − fee))
 *
 * and rejects quotes where
 *   - a memo pool is missing, inactive, has zero liquidity or no usable price;
 *   - the pools don't chain tokenIn → … → tokenOut by contract + symbol;
 *   - the router claims more than the chain can pay:
 *       expectedOut > spotOut × (1 + tol)              (stale / forged-high)
 *   - the guaranteed floor sits implausibly far below chain spot:
 *       guaranteedOut < spotOut × (1 − (impact + slippage + tol))
 *                                                     (forged-low / sandwich bait)
 */
import { fetchOnchainPools, type OnchainPool } from "@/lib/wax/alcor-onchain";
import { parseSwapMemo, type PolicyToken } from "@/lib/wallet/policy";
import { parseAsset } from "@/lib/wallet/tokens";

/** "warn" observes only (no latency, never blocks); "enforce" rejects before signing. */
export type OnchainCheckMode = "off" | "warn" | "enforce";

export type SpotLeg = { pool: OnchainPool; inIsA: boolean };

/** Alcor fee units: 3000 = 0.3 %. */
const feeFraction = (fee: number): number => Math.max(0, fee) / 1_000_000;

/** Upper bound on what a leg chain pays at spot (fee deducted, NO price impact). */
export function spotBoundOut(amountIn: number, legs: SpotLeg[]): number {
  let x = amountIn;
  for (const { pool, inIsA } of legs) {
    const p = pool.priceAInB;
    if (!p || !(p > 0)) throw new Error(`pool ${pool.id}: unusable on-chain price`);
    x = x * (inIsA ? p : 1 / p) * (1 - feeFraction(pool.fee));
  }
  return x;
}

export type QuoteCrossCheckInput = {
  /** Router legs as they will be signed (input asset + swapexactin memo). */
  swaps: { input: string; memo: string }[];
  account: string;
  tokenIn: Pick<PolicyToken, "symbol" | "contract">;
  tokenOut: Pick<PolicyToken, "symbol" | "contract">;
  /** Router-quoted output (tokenOut units). */
  expectedOut: number;
  /** Σ memo min-outs the chain will enforce (tokenOut units). */
  guaranteedOut: number;
  slippagePct: number;
  /** Largest acceptable price impact for the whole route, percent. */
  maxImpactPct: number;
  /** Drift allowance between the RPC read and the quote, percent (default 0.5). */
  tolerancePct?: number;
};

export type QuoteCrossCheckResult =
  | { ok: true; spotOut: number; deviationPct: number }
  | { ok: false; reason: string; spotOut?: number };

const sameToken = (
  a: { symbol: string; contract: string },
  b: { symbol: string; contract: string },
) => a.symbol.toUpperCase() === b.symbol.toUpperCase() && a.contract === b.contract;

/** Every pool id referenced by the router memos (for one batched RPC read). */
export function memoPoolIds(swaps: { memo: string }[], account: string): number[] {
  const ids = new Set<number>();
  for (const s of swaps) for (const id of parseSwapMemo(s.memo, account)?.poolIds ?? []) ids.add(id);
  return [...ids];
}

/** Pure check against already-fetched pool rows. Fails closed on anything unexpected. */
export function crossCheckQuoteAgainstPools(
  input: QuoteCrossCheckInput,
  pools: Map<number, OnchainPool>,
): QuoteCrossCheckResult {
  const tol = Math.max(0, input.tolerancePct ?? 0.5) / 100;
  if (input.swaps.length === 0) return { ok: false, reason: "no router legs to cross-check" };

  let spotOut = 0;
  for (const s of input.swaps) {
    const memo = parseSwapMemo(s.memo, input.account);
    if (!memo) return { ok: false, reason: "router memo failed validation" };
    const amt = parseAsset(s.input);
    if (!amt || !(amt.amount > 0) || amt.symbol.toUpperCase() !== input.tokenIn.symbol.toUpperCase()) {
      return { ok: false, reason: `router leg input isn't a ${input.tokenIn.symbol} amount` };
    }
    let cur = { symbol: input.tokenIn.symbol, contract: input.tokenIn.contract };
    const legs: SpotLeg[] = [];
    for (const id of memo.poolIds) {
      const pool = pools.get(id);
      if (!pool) return { ok: false, reason: `pool ${id} missing from the on-chain read` };
      if (!pool.active) return { ok: false, reason: `pool ${id} is inactive on-chain` };
      if (!/^[1-9]\d*$/.test(pool.liquidity)) {
        return { ok: false, reason: `pool ${id} has no on-chain liquidity` };
      }
      if (!pool.priceAInB || !(pool.priceAInB > 0)) {
        return { ok: false, reason: `pool ${id}: unusable on-chain price` };
      }
      let inIsA: boolean;
      if (sameToken(pool.tokenA, cur)) inIsA = true;
      else if (sameToken(pool.tokenB, cur)) inIsA = false;
      else {
        return {
          ok: false,
          reason: `pool ${id} does not trade ${cur.symbol}@${cur.contract} — memo route doesn't match the tokens`,
        };
      }
      legs.push({ pool, inIsA });
      const next = inIsA ? pool.tokenB : pool.tokenA;
      cur = { symbol: next.symbol, contract: next.contract };
    }
    if (!sameToken(cur, input.tokenOut)) {
      return {
        ok: false,
        reason: `memo route ends in ${cur.symbol}@${cur.contract}, not ${input.tokenOut.symbol}@${input.tokenOut.contract}`,
      };
    }
    spotOut += spotBoundOut(amt.amount, legs);
  }
  if (!(spotOut > 0)) return { ok: false, reason: "on-chain spot bound is zero" };

  const deviationPct = (input.expectedOut / spotOut - 1) * 100;
  if (input.expectedOut > spotOut * (1 + tol)) {
    return {
      ok: false,
      spotOut,
      reason: `router quotes ${input.expectedOut} but chain spot can pay at most ~${spotOut.toPrecision(8)} (+${deviationPct.toFixed(2)}%) — stale or forged quote`,
    };
  }
  const band = (Math.max(0, input.maxImpactPct) + Math.max(0, input.slippagePct)) / 100 + tol;
  const floor = spotOut * Math.max(0, 1 - band);
  if (input.guaranteedOut < floor) {
    return {
      ok: false,
      spotOut,
      reason: `guaranteed min-out ${input.guaranteedOut} is more than ${(band * 100).toFixed(2)}% under chain spot ~${spotOut.toPrecision(8)} — forged-low quote or sandwich bait`,
    };
  }
  return { ok: true, spotOut, deviationPct };
}

/** Read the memo's pools from chain (RPC pool, not the Alcor API) and cross-check. */
export async function crossCheckAlcorQuote(
  input: QuoteCrossCheckInput,
): Promise<QuoteCrossCheckResult> {
  const ids = memoPoolIds(input.swaps, input.account);
  if (ids.length === 0) return { ok: false, reason: "router memos reference no pools" };
  let pools: Map<number, OnchainPool>;
  try {
    pools = await fetchOnchainPools(ids);
  } catch (err) {
    return {
      ok: false,
      reason: `on-chain pool read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return crossCheckQuoteAgainstPools(input, pools);
}
