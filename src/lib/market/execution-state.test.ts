/**
 * P-C: ONE hot-pool definition shared by the spot loop, the snapshot's
 * tracked-hot refresh, and the gate's route-critical refresh.
 */
import { describe, expect, it } from "vitest";
import { hotPoolIds } from "./execution-state";
import type { AuxPool, LeefPool, SwapRoute } from "@/lib/leef/types";

function leefPool(
  id: number,
  over: { volume?: number; tvl?: number; pair?: string } = {},
): LeefPool {
  return {
    id,
    fee: 3000,
    feePct: 0.3,
    leef: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: 5_000_000 },
    pair: {
      symbol: over.pair ?? "WAX",
      contract: "eosio.token",
      decimals: 8,
      quantity: 1_000,
    },
    leefIsA: true,
    tvlUsd: over.tvl ?? 100,
    volume24Usd: over.volume ?? 0,
    volumeWeekUsd: 0,
    volumeUsdMonth: 0,
    volumeUsd90: 0,
    volumeLeef24: 0,
    volumePair24: 0,
    change24: 0,
    changeWeek: 0,
    liquidity: "0",
    pairPerLeef: 0.001,
    leefPerPair: 1_000,
    waxPerLeef: 0.001,
    usdPerLeef: null,
    tickSpacing: 60,
  };
}

function auxPool(id: number, tvl: number, withWax = true): AuxPool {
  return {
    id,
    fee: 3000,
    feePct: 0.3,
    tokenA: { symbol: withWax ? "WAX" : "AAA", contract: "eosio.token", decimals: 8, quantity: 1 },
    tokenB: { symbol: "USDT", contract: "usdt.alcor", decimals: 4, quantity: 1 },
    tvlUsd: tvl,
    volume24Usd: 0,
  };
}

function routeWith(poolIds: number[]): SwapRoute {
  return {
    id: "r",
    kind: "hop",
    label: "r",
    poolIds,
    legs: [],
    amountIn: 1,
    amountOut: 1,
    tokenIn: "WAX",
    tokenOut: "LEEF",
    feePct: 0.3,
    priceImpact: 0,
    executionPrice: 1,
    spotPrice: 1,
    vsBestPct: 0,
    tvlUsd: 0,
    volume24Usd: 0,
    notes: [],
  };
}

describe("hotPoolIds (P-C)", () => {
  const pools = [
    leefPool(1, { volume: 100, tvl: 50 }), // hottest by volume
    leefPool(2, { volume: 90 }),
    leefPool(3, { volume: 1, tvl: 9_000, pair: "USDT" }), // deepest of the volume-1 band
    ...Array.from({ length: 10 }, (_, i) => leefPool(100 + i, { volume: 1 })),
  ];
  const aux = [auxPool(900, 5_000), auxPool(901, 4_000), auxPool(902, 1, false)];

  it("contains the top-volume LEEF books, WAX-quoted LEEF and deep WAX aux", () => {
    const ids = hotPoolIds({ pools, aux });
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(3); // deep book earns its place on TVL tie-break
    expect(ids).toContain(900); // deepest WAX aux (price reference)
    expect(ids).toContain(901);
    expect(ids).not.toContain(902); // no WAX side — not a price reference
    expect(new Set(ids).size).toBe(ids.length); // deduped
  });

  it("always includes route-critical Alcor ids (gate semantics)", () => {
    const cold = leefPool(555, { volume: 0, tvl: 0 });
    const ids = hotPoolIds({ pools: [...pools, cold], aux }, { route: routeWith([555, 217]) });
    expect(ids).toContain(555);
    expect(ids).toContain(217);
  });

  it("excludes venue-namespaced route ids (not Alcor on-chain rows)", () => {
    const ids = hotPoolIds({ pools, aux }, { route: routeWith([1_000_042]) });
    expect(ids).not.toContain(1_000_042);
  });

  it("works without a route (spot-loop / snapshot semantics)", () => {
    const ids = hotPoolIds({ pools, aux });
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain(555);
  });
});
