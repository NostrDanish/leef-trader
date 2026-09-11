import { describe, expect, it } from "vitest";
import { bestExecutionRoute, rankExecutionRoutes } from "./route-optimizer";
import type { AuxPool, LeefPool } from "./types";

function leefPool(over: {
  id: number;
  wax: number;
  leef: number;
  fee?: number;
  pair?: { symbol: string; contract: string; quantity: number };
}): LeefPool {
  const pair = over.pair ?? {
    symbol: "WAX",
    contract: "eosio.token",
    quantity: over.wax,
  };
  return {
    id: over.id,
    fee: over.fee ?? 3000,
    feePct: (over.fee ?? 3000) / 10_000,
    leef: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: over.leef },
    pair: { ...pair, decimals: pair.symbol === "WAX" ? 8 : 4 },
    leefIsA: true,
    tvlUsd: 1000,
    volume24Usd: 50,
    volumeWeekUsd: 0,
    volumeUsdMonth: 0,
    volumeUsd90: 0,
    volumeLeef24: 0,
    volumePair24: 0,
    change24: 0,
    changeWeek: 0,
    liquidity: "0",
    pairPerLeef: pair.quantity / over.leef,
    leefPerPair: over.leef / pair.quantity,
    waxPerLeef: pair.symbol === "WAX" ? pair.quantity / over.leef : null,
    usdPerLeef: null,
    tickSpacing: 60,
  };
}

function aux(over: {
  id: number;
  a: { symbol: string; contract: string; quantity: number };
  b: { symbol: string; contract: string; quantity: number };
  fee?: number;
}): AuxPool {
  return {
    id: over.id,
    fee: over.fee ?? 3000,
    feePct: (over.fee ?? 3000) / 10_000,
    tokenA: { ...over.a, decimals: 4 },
    tokenB: { ...over.b, decimals: 8 },
    tvlUsd: 200,
    volume24Usd: 20,
  };
}

describe("execution router", () => {
  it("picks the deeper direct book for a small clip", () => {
    const pools = [
      leefPool({ id: 1, wax: 1_000, leef: 10_000_000 }),
      leefPool({ id: 2, wax: 50_000, leef: 500_000_000 }),
    ];
    const r = bestExecutionRoute(pools, [], 1, "WAX", "LEEF")!;
    expect(r.kind).toBe("direct");
    expect(r.poolIds[0]).toBe(2);
  });

  it("buy and sell can choose different books", () => {
    const pools = [
      leefPool({ id: 10, wax: 8_000, leef: 200_000_000 }), // cheap LEEF (lots of LEEF per WAX)
      leefPool({ id: 11, wax: 40_000, leef: 200_000_000 }), // rich LEEF (better sell)
    ];
    const buy = bestExecutionRoute(pools, [], 5, "WAX", "LEEF")!;
    const sell = bestExecutionRoute(pools, [], 1_000_000, "LEEF", "WAX")!;
    expect(buy.poolIds[0]).toBe(10);
    expect(sell.poolIds[0]).toBe(11);
  });

  it("takes a multi-hop when it genuinely beats direct", () => {
    // Direct WAX→LEEF is thin and expensive. Going WAX→USDT→LEEF is deep.
    const pools = [
      leefPool({ id: 20, wax: 80, leef: 1_200_000 }), // thin direct
      leefPool({
        id: 21,
        wax: 0,
        leef: 80_000_000,
        pair: { symbol: "USDT", contract: "usdt.alcor", quantity: 400 },
      }),
    ];
    const hops = [
      aux({
        id: 90,
        a: { symbol: "USDT", contract: "usdt.alcor", quantity: 2_000 },
        b: { symbol: "WAX", contract: "eosio.token", quantity: 100_000 },
      }),
    ];
    const ranked = rankExecutionRoutes(pools, hops, 10, "WAX", "LEEF");
    expect(ranked.length).toBeGreaterThan(0);
    const hop = ranked.find((r) => r.kind === "hop");
    const direct = ranked.find((r) => r.kind === "direct");
    expect(hop).toBeDefined();
    if (direct && hop) {
      expect(hop.amountOut).toBeGreaterThan(direct.amountOut);
      expect(ranked[0]!.kind).toBe("hop");
    }
  });

  it("keeps a cheap direct over a worse hop", () => {
    const pools = [leefPool({ id: 30, wax: 80_000, leef: 800_000_000 })];
    const hops = [
      aux({
        id: 91,
        a: { symbol: "USDT", contract: "usdt.alcor", quantity: 10 },
        b: { symbol: "WAX", contract: "eosio.token", quantity: 50 },
      }),
    ];
    const r = bestExecutionRoute(pools, hops, 5, "WAX", "LEEF")!;
    expect(r.kind).toBe("direct");
    expect(r.poolIds[0]).toBe(30);
  });

  it("splits a large clip across two books when that improves net output", () => {
    const pools = [
      leefPool({ id: 40, wax: 200, leef: 2_000_000 }),
      leefPool({ id: 41, wax: 200, leef: 2_000_000 }),
    ];
    const ranked = rankExecutionRoutes(pools, [], 80, "WAX", "LEEF");
    const split = ranked.find((r) => r.kind === "split");
    const single = ranked.find((r) => r.kind === "direct");
    expect(single).toBeDefined();
    if (split && single) {
      expect(split.amountOut).toBeGreaterThan(single.amountOut);
      expect(ranked[0]!.kind).toBe("split");
    }
  });

  it("does not split a tiny clip that fits in one book", () => {
    const pools = [
      leefPool({ id: 50, wax: 20_000, leef: 200_000_000 }),
      leefPool({ id: 51, wax: 20_000, leef: 200_000_000 }),
    ];
    const r = bestExecutionRoute(pools, [], 1, "WAX", "LEEF")!;
    expect(r.kind).toBe("direct");
  });

  it("rejects spoofed LEEF and empty sizes", () => {
    const fake: LeefPool = leefPool({ id: 60, wax: 10_000, leef: 10_000_000 });
    fake.leef = { ...fake.leef, contract: "token.leef" };
    expect(bestExecutionRoute([fake], [], 5, "WAX", "LEEF")).toBeNull();
    expect(rankExecutionRoutes([], [], 0, "WAX", "LEEF")).toEqual([]);
    expect(rankExecutionRoutes([], [], 5, "WAX", "WAX")).toEqual([]);
  });

  it("returns no trade when nothing is liquid enough", () => {
    const pools = [leefPool({ id: 70, wax: 2, leef: 1_000_000 })];
    expect(bestExecutionRoute(pools, [], 50, "WAX", "LEEF")).toBeNull();
  });

  it("picks a 4-hop path when every shorter path is worse", () => {
    // Direct is tiny. Chain of deep books: WAX→A→B→C→LEEF.
    const pools = [
      leefPool({ id: 80, wax: 40, leef: 1_100_000 }),
      leefPool({
        id: 81,
        wax: 0,
        leef: 90_000_000,
        pair: { symbol: "CCC", contract: "tokenccc1111", quantity: 9_000 },
      }),
    ];
    const hops = [
      aux({
        id: 201,
        a: { symbol: "AAA", contract: "tokenaaa1111", quantity: 8_000 },
        b: { symbol: "WAX", contract: "eosio.token", quantity: 80_000 },
      }),
      aux({
        id: 202,
        a: { symbol: "BBB", contract: "tokenbbb1111", quantity: 8_000 },
        b: { symbol: "AAA", contract: "tokenaaa1111", quantity: 8_000 },
      }),
      aux({
        id: 203,
        a: { symbol: "CCC", contract: "tokenccc1111", quantity: 8_000 },
        b: { symbol: "BBB", contract: "tokenbbb1111", quantity: 8_000 },
      }),
    ];
    const ranked = rankExecutionRoutes(pools, hops, 8, "WAX", "LEEF", 10);
    const hop = ranked.find((r) => r.kind === "hop" && r.legs.length >= 4);
    const direct = ranked.find((r) => r.kind === "direct");
    expect(hop).toBeDefined();
    if (hop && direct) expect(hop.amountOut).toBeGreaterThan(direct.amountOut);
    if (hop) expect(ranked[0]!.legs.length).toBeGreaterThanOrEqual(4);
  });

  it("does not prefer extra hops that lose destination amount", () => {
    const pools = [leefPool({ id: 90, wax: 80_000, leef: 800_000_000 })];
    const hops = [
      aux({
        id: 301,
        a: { symbol: "USDT", contract: "usdt.alcor", quantity: 5 },
        b: { symbol: "WAX", contract: "eosio.token", quantity: 20 },
      }),
    ];
    const r = bestExecutionRoute(pools, hops, 5, "WAX", "LEEF")!;
    expect(r.kind).toBe("direct");
  });
});
