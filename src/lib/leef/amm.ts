import type { AuxPool, LeefPool, QuoteLeg, SwapRoute, TokenRef } from "./types";
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

function reservesForSwap(
  pool: LeefPool,
  tokenIn: string,
  tokenOut: string,
): { reserveIn: number; reserveOut: number } | null {
  const leef = pool.leef.symbol.toUpperCase();
  const pair = pool.pair.symbol.toUpperCase();
  const tin = tokenIn.toUpperCase();
  const tout = tokenOut.toUpperCase();
  if (tin === leef && tout === pair) {
    return { reserveIn: pool.leef.quantity, reserveOut: pool.pair.quantity };
  }
  if (tin === pair && tout === leef) {
    return { reserveIn: pool.pair.quantity, reserveOut: pool.leef.quantity };
  }
  return null;
}

function quotePool(
  pool: LeefPool,
  amountIn: number,
  tokenIn: string,
  tokenOut: string,
): QuoteLeg | null {
  if (tokenIn.toUpperCase() === tokenOut.toUpperCase()) return null;
  const r = reservesForSwap(pool, tokenIn, tokenOut);
  if (!r) return null;
  if (r.reserveIn < amountIn * 1.5) return null;
  const q = quoteConstantProduct(amountIn, r.reserveIn, r.reserveOut, pool.fee);
  if (q.amountOut <= 0 || q.priceImpact >= 0.35) return null;
  return {
    poolId: pool.id,
    pairName: `LEEF / ${pool.pair.symbol}`,
    tokenIn: tokenIn.toUpperCase(),
    tokenOut: tokenOut.toUpperCase(),
    amountIn,
    amountOut: q.amountOut,
    feePct: pool.feePct,
    priceImpact: q.priceImpact,
  };
}

function auxReserves(
  pool: AuxPool,
  tokenIn: string,
  tokenOut: string,
): { reserveIn: number; reserveOut: number } | null {
  const a = pool.tokenA.symbol.toUpperCase();
  const b = pool.tokenB.symbol.toUpperCase();
  const tin = tokenIn.toUpperCase();
  const tout = tokenOut.toUpperCase();
  if (tin === a && tout === b) {
    return { reserveIn: pool.tokenA.quantity, reserveOut: pool.tokenB.quantity };
  }
  if (tin === b && tout === a) {
    return { reserveIn: pool.tokenB.quantity, reserveOut: pool.tokenA.quantity };
  }
  return null;
}

function quoteAux(
  pool: AuxPool,
  amountIn: number,
  tokenIn: string,
  tokenOut: string,
): QuoteLeg | null {
  if (tokenIn.toUpperCase() === tokenOut.toUpperCase()) return null;
  const r = auxReserves(pool, tokenIn, tokenOut);
  if (!r) return null;
  if (r.reserveIn < amountIn * 1.5) return null;
  const q = quoteConstantProduct(amountIn, r.reserveIn, r.reserveOut, pool.fee);
  if (q.amountOut <= 0 || q.priceImpact >= 0.35) return null;
  return {
    poolId: pool.id,
    pairName: `${pool.tokenA.symbol} / ${pool.tokenB.symbol}`,
    tokenIn: tokenIn.toUpperCase(),
    tokenOut: tokenOut.toUpperCase(),
    amountIn,
    amountOut: q.amountOut,
    feePct: pool.feePct,
    priceImpact: q.priceImpact,
  };
}

function combineImpact(legs: QuoteLeg[]): number {
  let keep = 1;
  for (const leg of legs) keep *= 1 - leg.priceImpact;
  return Math.max(0, 1 - keep);
}

function routeFromLegs(
  kind: "direct" | "hop",
  legs: QuoteLeg[],
  tvlUsd: number,
  volume24Usd: number,
  notes: string[],
): SwapRoute {
  const first = legs[0]!;
  const last = legs[legs.length - 1]!;
  const amountIn = first.amountIn;
  const amountOut = last.amountOut;
  const feePct = 1 - legs.reduce((acc, l) => acc * (1 - l.feePct / 100), 1);
  const spot = legs.reduce((acc, l) => {
    const px = l.amountIn > 0 ? l.amountOut / l.amountIn / (1 - l.priceImpact || 1) : 0;
    return acc * (px || 1);
  }, 1);
  return {
    id: `${kind}-${legs.map((l) => l.poolId).join("-")}`,
    kind,
    label:
      kind === "direct"
        ? `${first.pairName} · #${first.poolId}`
        : legs.map((l) => `#${l.poolId} ${l.tokenIn}→${l.tokenOut}`).join(" · "),
    poolIds: legs.map((l) => l.poolId),
    legs,
    amountIn,
    amountOut,
    tokenIn: first.tokenIn,
    tokenOut: last.tokenOut,
    feePct: feePct * 100,
    priceImpact: combineImpact(legs),
    executionPrice: amountIn > 0 ? amountOut / amountIn : 0,
    spotPrice: spot,
    vsBestPct: 0,
    tvlUsd,
    volume24Usd,
    notes,
  };
}

/**
 * Quote every backed LEEF pool (and 2-hop via WAX or the pair token).
 * Ranked by output descending — the first row is the best fill.
 */
export function compareAllRoutes(
  pools: LeefPool[],
  aux: AuxPool[],
  amountIn: number,
  tokenIn: string,
  tokenOut: string,
): SwapRoute[] {
  if (amountIn <= 0) return [];
  const tin = tokenIn.toUpperCase();
  const tout = tokenOut.toUpperCase();
  const book = backedPools(pools);
  const routes: SwapRoute[] = [];
  const seen = new Set<string>();

  const push = (route: SwapRoute) => {
    if (seen.has(route.id)) return;
    seen.add(route.id);
    routes.push(route);
  };

  for (const pool of book) {
    const leg = quotePool(pool, amountIn, tin, tout);
    if (!leg) continue;
    const notes: string[] = [];
    if (pool.pair.quantity < amountIn * 0.05 && tin === pool.pair.symbol.toUpperCase()) {
      notes.push("Thin pair-side depth");
    }
    if (pool.leef.quantity < amountIn && tout === "LEEF") {
      notes.push("Thin LEEF depth");
    }
    if (pool.feePct >= 1) notes.push("1% fee tier");
    push(routeFromLegs("direct", [leg], pool.tvlUsd, pool.volume24Usd, notes));
  }

  const via = "WAX";
  if (tin !== via && tout !== via && (tin === "LEEF" || tout === "LEEF")) {
    const firstHops: QuoteLeg[] = [];
    for (const pool of book) {
      if (pool.pair.symbol.toUpperCase() !== via) continue;
      const leg = quotePool(pool, amountIn, tin, via);
      if (leg) firstHops.push(leg);
    }
    for (const pool of aux) {
      const leg = quoteAux(pool, amountIn, tin, via);
      if (leg) firstHops.push(leg);
    }

    for (const hop1 of firstHops) {
      const secondCandidates: QuoteLeg[] = [];
      for (const pool of book) {
        const leg = quotePool(pool, hop1.amountOut, via, tout);
        if (leg) secondCandidates.push(leg);
      }
      for (const pool of aux) {
        const leg = quoteAux(pool, hop1.amountOut, via, tout);
        if (leg) secondCandidates.push(leg);
      }
      for (const hop2 of secondCandidates) {
        if (hop2.poolId === hop1.poolId) continue;
        if (hop1.tokenIn !== tin || hop2.tokenOut !== tout) continue;
        if (hop1.tokenOut === hop2.tokenOut) continue;
        const tvl =
          (book.find((p) => p.id === hop1.poolId)?.tvlUsd ?? 0) +
          (book.find((p) => p.id === hop2.poolId)?.tvlUsd ??
            aux.find((p) => p.id === hop2.poolId)?.tvlUsd ??
            0);
        const vol =
          (book.find((p) => p.id === hop1.poolId)?.volume24Usd ?? 0) +
          (book.find((p) => p.id === hop2.poolId)?.volume24Usd ??
            aux.find((p) => p.id === hop2.poolId)?.volume24Usd ??
            0);
        push(
          routeFromLegs("hop", [hop1, hop2], tvl, vol, [
            "Two-hop via WAX",
            "Double fee",
          ]),
        );
      }
    }
  }

  if (tin === "WAX" && tout === "LEEF") {
    for (const leefPool of book) {
      const pair = leefPool.pair.symbol.toUpperCase();
      if (pair === "WAX") continue;
      for (const a of aux) {
        const hop1 = quoteAux(a, amountIn, "WAX", pair);
        if (!hop1) continue;
        const hop2 = quotePool(leefPool, hop1.amountOut, pair, "LEEF");
        if (!hop2) continue;
        push(
          routeFromLegs(
            "hop",
            [hop1, hop2],
            leefPool.tvlUsd + a.tvlUsd,
            leefPool.volume24Usd + a.volume24Usd,
            [`Via ${pair} #${leefPool.id}`, "Double fee"],
          ),
        );
      }
    }
  }

  if (tin === "LEEF" && tout === "WAX") {
    for (const leefPool of book) {
      const pair = leefPool.pair.symbol.toUpperCase();
      if (pair === "WAX") continue;
      const hop1 = quotePool(leefPool, amountIn, "LEEF", pair);
      if (!hop1) continue;
      for (const a of aux) {
        const hop2 = quoteAux(a, hop1.amountOut, pair, "WAX");
        if (!hop2) continue;
        push(
          routeFromLegs(
            "hop",
            [hop1, hop2],
            leefPool.tvlUsd + a.tvlUsd,
            leefPool.volume24Usd + a.volume24Usd,
            [`Via ${pair} #${leefPool.id}`, "Double fee"],
          ),
        );
      }
    }
  }

  routes.sort((a, b) => b.amountOut - a.amountOut);
  const bestDirect = routes.find((r) => r.kind === "direct");
  const sane =
    bestDirect != null
      ? routes.filter(
          (r) => r.kind === "direct" || r.amountOut <= bestDirect.amountOut * 1.6,
        )
      : routes;
  const ranked = sane.length > 0 ? sane : routes;
  ranked.sort((a, b) => b.amountOut - a.amountOut);
  const best = ranked[0]?.amountOut ?? 0;
  for (const r of ranked) {
    r.vsBestPct = best > 0 ? r.amountOut / best - 1 : 0;
  }
  return ranked;
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
