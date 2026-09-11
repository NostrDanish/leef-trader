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
