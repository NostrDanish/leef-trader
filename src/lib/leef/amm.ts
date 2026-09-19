import type { LeefPool, TokenRef } from "./types";
import { LEEF_CONTRACT, LEEF_SYMBOL, WAX_CONTRACT, WAX_SYMBOL } from "./types";

/** Alcor fee units: 3000 = 0.30%. */
export function feeToPct(fee: number): number {
  return fee / 10_000;
}

/** Swap recommendations ignore books thinner than this LEEF reserve. */
export const MIN_LEEF_BACKING = 1_000_000;

export function isBackedPool(p: Pick<LeefPool, "leef">): boolean {
  return Number.isFinite(p.leef.quantity) && p.leef.quantity >= MIN_LEEF_BACKING;
}

export function backedPools(pools: LeefPool[]): LeefPool[] {
  return pools.filter(isBackedPool);
}

export function quoteConstantProduct(
  amountIn: number,
  reserveIn: number,
  reserveOut: number,
  fee: number,
): {
  amountOut: number;
  priceImpact: number;
  feePaid: number;
  executionPrice: number;
  spotPrice: number;
} {
  const spotPrice = reserveIn > 0 ? reserveOut / reserveIn : 0;
  if (amountIn <= 0 || reserveIn <= 0 || reserveOut <= 0) {
    return {
      amountOut: 0,
      priceImpact: 0,
      feePaid: 0,
      executionPrice: 0,
      spotPrice,
    };
  }
  const feeRate = fee / 1_000_000;
  const feePaid = amountIn * feeRate;
  const amountInWithFee = amountIn * (1 - feeRate);
  const amountOut =
    (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee);
  const executionPrice = amountOut / amountIn;
  const expected = spotPrice * (1 - feeRate);
  const priceImpact =
    expected > 0 ? Math.max(0, 1 - executionPrice / expected) : 0;
  return { amountOut, priceImpact, feePaid, executionPrice, spotPrice };
}

/**
 * Uniswap-V3 virtual constant-product reserves for an Alcor CLMM pool:
 *   rx = L·2⁶⁴/√P  (token A, raw units)
 *   ry = L·√P/2⁶⁴  (token B, raw units)
 * Constant-product over THESE is anchored at the tick price — exact at the
 * margin, and exact for any fill that stays inside the current tick range.
 * Raw pool balances are NOT CP reserves for concentrated liquidity (level
 * error measured at +56.8%/−36.2% on pool 217 — ALCOR_COMPARATIVE_AUDIT §3.3).
 * Null when the pool carries no usable CLMM state (L ≤ 0 or √P missing);
 * callers fall back to raw reserves (exact for Defibox/Taco true-CP pools).
 */
export function virtualReserves(pool: {
  liquidity?: string;
  sqrtPriceX64?: string;
}): { rx: bigint; ry: bigint } | null {
  if (!pool.liquidity || !pool.sqrtPriceX64) return null;
  try {
    const L = BigInt(pool.liquidity);
    const sqrtP = BigInt(pool.sqrtPriceX64);
    if (L <= 0n || sqrtP <= 0n) return null;
    const Q64 = 1n << 64n;
    const rx = (L * Q64) / sqrtP;
    const ry = (L * sqrtP) / Q64;
    if (rx <= 0n || ry <= 0n) return null;
    return { rx, ry };
  } catch {
    return null;
  }
}

/**
 * Human-unit virtual reserves for the leef/pair sides of a LeefPool
 * (`leefIsA` maps the A/B sides), or null when the pool lacks CLMM state.
 */
export function virtualLeefPairReserves(
  pool: Pick<LeefPool, "liquidity" | "sqrtPriceX64" | "leef" | "pair" | "leefIsA">,
): { leef: number; pair: number } | null {
  const v = virtualReserves(pool);
  if (!v) return null;
  const leef = Number(pool.leefIsA ? v.rx : v.ry) / 10 ** pool.leef.decimals;
  const pair = Number(pool.leefIsA ? v.ry : v.rx) / 10 ** pool.pair.decimals;
  if (!Number.isFinite(leef) || !Number.isFinite(pair) || leef <= 0 || pair <= 0) return null;
  return { leef, pair };
}

export function q64Price(
  sqrtPriceX64: string | undefined,
  decA: number,
  decB: number,
): number | null {
  if (!sqrtPriceX64) return null;
  try {
    const raw = BigInt(sqrtPriceX64);
    const scale = 10n ** 12n;
    const sqrtP = Number((raw * scale) / (1n << 64n)) / 1e12;
    if (!Number.isFinite(sqrtP) || sqrtP <= 0) return null;
    const price = sqrtP * sqrtP * 10 ** (decA - decB);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/**
 * Canonical token identity. A token is contract + symbol + precision — never
 * a symbol alone. Any "LEEF" not issued by leefmaincorp (and any "WAX" not
 * issued by eosio.token) is a different token, full stop: it must not feed
 * pricing, routing, arb scans or signing. Fail closed.
 */
export function isLeefToken(t: { symbol?: string; contract?: string }): boolean {
  return t.symbol?.toUpperCase() === LEEF_SYMBOL && t.contract === LEEF_CONTRACT;
}

export function isWaxToken(t: { symbol?: string; contract?: string }): boolean {
  return t.symbol?.toUpperCase() === WAX_SYMBOL && t.contract === WAX_CONTRACT;
}

export function pairTokens(pools: LeefPool[], extra: string[] = []): string[] {
  const set = new Set<string>(["LEEF", "WAX", ...extra.map((s) => s.toUpperCase())]);
  for (const p of backedPools(pools)) {
    if (p.volume24Usd >= 0.4 || p.tvlUsd >= 15) {
      set.add(p.pair.symbol.toUpperCase());
    }
  }
  return [...set];
}

export function waxPerLeefFromPool(pool: LeefPool): number | null {
  if (pool.pair.symbol.toUpperCase() === "WAX") return pool.pairPerLeef;
  return pool.waxPerLeef;
}

export function emptyToken(
  symbol: string,
  contract: string,
  decimals: number,
  quantity = 0,
): TokenRef {
  return { symbol, contract, decimals, quantity };
}
