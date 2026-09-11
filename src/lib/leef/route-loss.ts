import { backedPools, MIN_LEEF_BACKING, quoteConstantProduct } from "./amm";
import { rankExecutionRoutes } from "./route-optimizer";
import type { LeefPool, LeefSnapshot, SwapRoute } from "./types";

export { backedPools, isBackedPool, MIN_LEEF_BACKING } from "./amm";

export type BookSide = {
  amountIn: number;
  amountOut: number;
  impact: number;
  feePct: number;
  /** USD-equivalent received (buy: LEEF marked at fair; sell: pair marked at pair USD). */
  usdOut: number;
  /** 0 = best among backed books. Positive = you give up this much vs the leader. */
  loss: number;
};

export type BookScore = {
  pool: LeefPool;
  leefBacking: number;
  pairPerMillion: number;
  usdPerMillion: number;
  unit: string;
  buy: BookSide | null;
  sell: BookSide | null;
  bestBuy: boolean;
  bestSell: boolean;
};

const STABLES = new Set(["USDT", "USDC", "WAXUSDT", "WAXUSDC"]);

export function usdPerPairToken(pool: LeefPool, waxUsd: number): number {
  const s = pool.pair.symbol.toUpperCase();
  if (s === "WAX" || s === "WAXP") return waxUsd > 0 ? waxUsd : 0;
  if (STABLES.has(s)) return 1;
  if (pool.usdPerLeef && pool.pairPerLeef > 0) return pool.usdPerLeef / pool.pairPerLeef;
  if (pool.waxPerLeef && pool.pairPerLeef > 0 && waxUsd > 0) {
    return (pool.waxPerLeef / pool.pairPerLeef) * waxUsd;
  }
  return 0;
}

export function usdPerMillion(
  pool: LeefPool,
  waxUsd: number,
  leefUsd: number,
): number {
  const u =
    pool.usdPerLeef ??
    (pool.waxPerLeef != null && waxUsd > 0 ? pool.waxPerLeef * waxUsd : leefUsd);
  return u * 1_000_000;
}

function quoteSide(
  amountIn: number,
  reserveIn: number,
  reserveOut: number,
  fee: number,
): { amountOut: number; impact: number } | null {
  if (amountIn <= 0 || reserveIn < amountIn * 1.05 || reserveOut <= 0) return null;
  const q = quoteConstantProduct(amountIn, reserveIn, reserveOut, fee);
  if (q.amountOut <= 0 || q.priceImpact >= 0.45) return null;
  return { amountOut: q.amountOut, impact: q.priceImpact };
}

/**
 * Score every ≥1M LEEF book on buy (pair → LEEF) and sell (LEEF → pair).
 * Loss is vs the best USD result so WAX, USDT, TLM, etc. sit on one tape.
 */
export function scoreBooks(
  snap: LeefSnapshot,
  buyUsd = Math.max(snap.waxUsd * 10, 0.05),
  sellLeef = 1_000_000,
): BookScore[] {
  const book = backedPools(snap.pools);
  const fairLeef = snap.leefUsd > 0 ? snap.leefUsd : 0;
  const rows: BookScore[] = [];

  for (const pool of book) {
    const pairUsd = usdPerPairToken(pool, snap.waxUsd);
    const pairIn = pairUsd > 0 ? buyUsd / pairUsd : 0;
    const sellIn = Math.min(sellLeef, pool.leef.quantity * 0.2);

    let buy: BookSide | null = null;
    if (pairIn > 0) {
      const q = quoteSide(pairIn, pool.pair.quantity, pool.leef.quantity, pool.fee);
      if (q) {
        const usdOut = q.amountOut * fairLeef;
        buy = {
          amountIn: pairIn,
          amountOut: q.amountOut,
          impact: q.impact,
          feePct: pool.feePct,
          usdOut,
          loss: 0,
        };
      }
    }

    let sell: BookSide | null = null;
    if (sellIn > 0 && pairUsd > 0) {
      const q = quoteSide(sellIn, pool.leef.quantity, pool.pair.quantity, pool.fee);
      if (q) {
        const usdOut = (q.amountOut * pairUsd * sellLeef) / sellIn;
        sell = {
          amountIn: sellIn,
          amountOut: (q.amountOut * sellLeef) / sellIn,
          impact: q.impact,
          feePct: pool.feePct,
          usdOut,
          loss: 0,
        };
      }
    }

    rows.push({
      pool,
      leefBacking: pool.leef.quantity,
      pairPerMillion: pool.pairPerLeef * 1_000_000,
      usdPerMillion: usdPerMillion(pool, snap.waxUsd, snap.leefUsd),
      unit: `${pool.pair.symbol} / 1M`,
      buy,
      sell,
      bestBuy: false,
      bestSell: false,
    });
  }

  const fairM = fairLeef * 1_000_000;
  const sane = (r: BookScore) => {
    const sym = r.pool.pair.symbol.toUpperCase();
    if (!(r.usdPerMillion > 0)) return false;
    if (sym === "WAX" || STABLES.has(sym)) return true;
    if (!(fairM > 0)) return false;
    const ratio = r.usdPerMillion / fairM;
    return ratio >= 0.1 && ratio <= 10;
  };

  const ranked = rows.filter(sane);
  const bestBuyUsd = Math.max(0, ...ranked.map((r) => r.buy?.usdOut ?? 0));
  const bestSellUsd = Math.max(0, ...ranked.map((r) => r.sell?.usdOut ?? 0));
  for (const r of rows) {
    if (!sane(r)) {
      if (r.buy) r.buy.loss = 1;
      if (r.sell) r.sell.loss = 1;
      continue;
    }
    if (r.buy && bestBuyUsd > 0) r.buy.loss = 1 - r.buy.usdOut / bestBuyUsd;
    if (r.sell && bestSellUsd > 0) r.sell.loss = 1 - r.sell.usdOut / bestSellUsd;
  }
  const buyWinner = [...ranked].sort((a, b) => (b.buy?.usdOut ?? 0) - (a.buy?.usdOut ?? 0))[0];
  const sellWinner = [...ranked].sort((a, b) => (b.sell?.usdOut ?? 0) - (a.sell?.usdOut ?? 0))[0];
  if (buyWinner?.buy) buyWinner.bestBuy = true;
  if (sellWinner?.sell) sellWinner.bestSell = true;

  return rows.sort((a, b) => {
    const al = Math.min(a.buy?.loss ?? 1, a.sell?.loss ?? 1);
    const bl = Math.min(b.buy?.loss ?? 1, b.sell?.loss ?? 1);
    return al - bl;
  });
}

export function leefLegPoolId(route: SwapRoute): number {
  const leefLeg = [...route.legs].reverse().find((l) => l.tokenOut === "LEEF" || l.tokenIn === "LEEF");
  return leefLeg?.poolId ?? route.poolIds[route.poolIds.length - 1] ?? route.poolIds[0]!;
}

export function routeForSwap(
  snap: LeefSnapshot,
  amountIn: number,
  tokenIn: string,
  tokenOut: string,
): SwapRoute[] {
  return rankExecutionRoutes(snap.pools, snap.aux, amountIn, tokenIn, tokenOut);
}
