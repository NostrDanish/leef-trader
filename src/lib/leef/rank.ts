import { feeApyPct, turnoverOf } from "./analytics";
import { quoteConstantProduct, waxPerLeefFromPool } from "./amm";
import { scoreBooks } from "./route-loss";
import type { LeefPool, LeefSnapshot, RankedPool, TradeBadge } from "./types";

function logNorm(v: number, max: number): number {
  if (max <= 0) return 0;
  return Math.log1p(Math.max(0, v)) / Math.log1p(max);
}

function impactOn(
  pool: LeefPool,
  amountIn: number,
  side: "buy-leef" | "sell-leef",
): number | null {
  if (side === "buy-leef") {
    const q = quoteConstantProduct(
      amountIn,
      pool.pair.quantity,
      pool.leef.quantity,
      pool.fee,
    );
    return q.amountOut > 0 ? q.priceImpact : null;
  }
  const q = quoteConstantProduct(
    amountIn,
    pool.leef.quantity,
    pool.pair.quantity,
    pool.fee,
  );
  return q.amountOut > 0 ? q.priceImpact : null;
}

export function rankPools(pools: LeefPool[], snap?: LeefSnapshot): RankedPool[] {
  const maxTvl = Math.max(...pools.map((p) => p.tvlUsd), 1);
  const maxVol = Math.max(...pools.map((p) => p.volume24Usd), 1);

  const scored = snap ? scoreBooks(snap) : [];
  const bestBuyId = scored.find((s) => s.bestBuy)?.pool.id ?? null;
  const bestSellId = scored.find((s) => s.bestSell)?.pool.id ?? null;

  const waxPrices = pools
    .map((p) => waxPerLeefFromPool(p))
    .filter((n): n is number => n != null && n > 0)
    .sort((a, b) => a - b);
  const medianWax =
    waxPrices.length > 0
      ? waxPrices[Math.floor(waxPrices.length / 2)]!
      : null;

  const deepestId = [...pools].sort((a, b) => b.tvlUsd - a.tvlUsd)[0]?.id;
  const mostTradedId = [...pools].sort((a, b) => b.volume24Usd - a.volume24Usd)[0]?.id;

  return pools
    .map((p) => {
      const tvlScore = logNorm(p.tvlUsd, maxTvl);
      const volScore = logNorm(p.volume24Usd, maxVol);
      const buyImp = impactOn(p, Math.max(p.pair.quantity * 0.001, 1e-6), "buy-leef");
      const sellImp = impactOn(p, Math.min(1_000_000, p.leef.quantity * 0.1), "sell-leef");
      const impactScore =
        buyImp == null ? 0.35 : Math.max(0, 1 - Math.min(buyImp * 8, 1));
      const feeScore = Math.max(0, 1 - p.feePct / 1);
      const wax = waxPerLeefFromPool(p);
      const vsMedian =
        wax != null && medianWax
          ? (wax - medianWax) / medianWax
          : null;
      const tradeScore =
        0.4 * tvlScore + 0.3 * volScore + 0.2 * impactScore + 0.1 * feeScore;

      const badges: TradeBadge[] = [];
      if (p.id === bestBuyId) badges.push("best-buy");
      if (p.id === bestSellId) badges.push("best-sell");
      if (p.id === deepestId) badges.push("deepest");
      if (p.id === mostTradedId) badges.push("most-traded");
      if (vsMedian != null && Math.abs(vsMedian) >= 0.08) badges.push("mispriced");
      if (p.leef.quantity < 1_000_000 || p.tvlUsd < 2 || p.volume24Usd < 0.05) {
        badges.push("thin");
      }

      return {
        ...p,
        tradeScore,
        impactBuy10Wax: buyImp,
        impactSell1mLeef: sellImp,
        badges,
        waxPerMillionLeef: wax != null ? wax * 1_000_000 : null,
        vsMedianWaxPct: vsMedian,
        turnover: turnoverOf(p),
        feeApyPct: feeApyPct(p),
      };
    })
    .sort((a, b) => b.tradeScore - a.tradeScore);
}

export function headline(ranked: RankedPool[]): {
  bestBuy?: RankedPool;
  bestSell?: RankedPool;
  deepest?: RankedPool;
  mostTraded?: RankedPool;
  arb?: { cheap: RankedPool; rich: RankedPool; spreadPct: number };
} {
  const bestBuy = ranked.find((p) => p.badges.includes("best-buy"));
  const bestSell = ranked.find((p) => p.badges.includes("best-sell"));
  const deepest = ranked.find((p) => p.badges.includes("deepest"));
  const mostTraded = ranked.find((p) => p.badges.includes("most-traded"));
  const waxPx = ranked
    .filter(
      (p) =>
        p.pair.symbol.toUpperCase() === "WAX" &&
        p.usdPerLeef != null &&
        p.usdPerLeef > 0 &&
        p.leef.quantity >= 1_000_000,
    )
    .map((p) => p.usdPerLeef!)
    .sort((a, b) => a - b);
  const fair = waxPx[Math.floor(waxPx.length / 2)];
  const priced = ranked.filter((p) => {
    if (!p.usdPerLeef || p.usdPerLeef <= 0) return false;
    if (p.leef.quantity < 1_000_000 || p.badges.includes("thin")) return false;
    if (fair == null) return true;
    const ratio = p.usdPerLeef / fair;
    return ratio >= 0.15 && ratio <= 6;
  });
  const cheap = [...priced].sort((a, b) => (a.usdPerLeef ?? 0) - (b.usdPerLeef ?? 0))[0];
  const rich = [...priced].sort((a, b) => (b.usdPerLeef ?? 0) - (a.usdPerLeef ?? 0))[0];
  let arb: { cheap: RankedPool; rich: RankedPool; spreadPct: number } | undefined;
  if (cheap && rich && cheap.id !== rich.id && cheap.usdPerLeef && rich.usdPerLeef) {
    const spreadPct = rich.usdPerLeef / cheap.usdPerLeef - 1;
    if (spreadPct >= 0.03 && spreadPct < 1.5) arb = { cheap, rich, spreadPct };
  }
  return { bestBuy, bestSell, deepest, mostTraded, arb };
}
