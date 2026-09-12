import { describe, expect, it } from "vitest";
import type { LeefPool, SwapRoute } from "@/lib/leef/types";
import { RouteCache, poolFingerprint, routeCache, routesCached } from "./route-cache";

function mkPool(id: number, wax: number, leef: number, over: Partial<LeefPool> = {}): LeefPool {
  const pairPerLeef = wax / leef;
  return {
    id,
    fee: 3000,
    feePct: 0.3,
    leef: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: leef },
    pair: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: wax },
    leefIsA: true,
    tvlUsd: wax * 0.04 * 2,
    volume24Usd: 10,
    volumeWeekUsd: 0,
    volumeUsdMonth: 0,
    volumeUsd90: 0,
    volumeLeef24: 0,
    volumePair24: 0,
    change24: 0,
    changeWeek: 0,
    liquidity: "12345",
    pairPerLeef,
    leefPerPair: 1 / pairPerLeef,
    waxPerLeef: pairPerLeef,
    usdPerLeef: pairPerLeef * 0.04,
    tickSpacing: 60,
    ...over,
  };
}

function mkRoute(id: string, out = 99): SwapRoute {
  return {
    id,
    kind: "direct",
    label: id,
    poolIds: [1],
    legs: [],
    amountIn: 10,
    amountOut: out,
    tokenIn: "WAX",
    tokenOut: "LEEF",
    feePct: 0.3,
    priceImpact: 0.001,
    executionPrice: out / 10,
    spotPrice: out / 10,
    vsBestPct: 0,
    tvlUsd: 100,
    volume24Usd: 10,
    notes: [],
  };
}

describe("RouteCache dependency invalidation", () => {
  it("a pool the route depends on changing invalidates it", () => {
    const cache = new RouteCache();
    const p1 = mkPool(1, 50_000, 500_000_000);
    cache.notePools([p1]);
    cache.put({
      key: "leef-wax",
      inputsKey: "10",
      routes: [mkRoute("r1")],
      poolIds: [1],
      poolVersions: { 1: cache.versionOf(1) },
    });
    expect(cache.get("leef-wax")).not.toBeNull();
    expect(cache.isFresh(cache.get("leef-wax")!)).toBe(true);

    // Pool 1's state moves on-chain (sqrt price change).
    const changed = cache.notePools([mkPool(1, 50_000, 500_000_000, { sqrtPriceX64: "777" })]);
    expect(changed).toEqual([1]);
    expect(cache.isFresh(cache.get("leef-wax")!)).toBe(false);
  });

  it("an UNRELATED pool changing keeps the route valid", () => {
    const cache = new RouteCache();
    const p1 = mkPool(1, 50_000, 500_000_000);
    const p2 = mkPool(2, 8_000, 90_000_000);
    cache.notePools([p1, p2]);
    cache.put({
      key: "leef-wax",
      inputsKey: "10",
      routes: [mkRoute("r1")],
      poolIds: [1],
      poolVersions: { 1: cache.versionOf(1) },
    });
    // Some random NFT-collection pool flips — nothing to do with our route.
    const changed = cache.notePools([mkPool(2, 9_000, 90_000_000)]);
    expect(changed).toEqual([2]);
    expect(cache.isFresh(cache.get("leef-wax")!)).toBe(true);
  });

  it("identical pool state does not bump versions (no recompute without reason)", () => {
    const p = mkPool(1, 50_000, 500_000_000);
    const fp1 = poolFingerprint(p);
    const fp2 = poolFingerprint(mkPool(1, 50_000, 500_000_000));
    expect(fp1).toBe(fp2);
    // A changed price or liquidity does.
    expect(poolFingerprint(mkPool(1, 50_000, 490_000_000))).not.toBe(fp1);
    expect(poolFingerprint(mkPool(1, 50_000, 500_000_000, { liquidity: "999" }))).not.toBe(fp1);
  });

  it("invalidateAll (browser resume) drops every cached route", () => {
    const cache = new RouteCache();
    cache.notePools([mkPool(1, 1, 1), mkPool(2, 1, 1)]);
    cache.put({
      key: "a",
      inputsKey: "x",
      routes: [mkRoute("a")],
      poolIds: [1],
      poolVersions: { 1: cache.versionOf(1) },
    });
    cache.put({
      key: "b",
      inputsKey: "x",
      routes: [mkRoute("b")],
      poolIds: [2],
      poolVersions: { 2: cache.versionOf(2) },
    });
    cache.invalidateAll();
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBeNull();
    const stats = cache.stats();
    expect(stats.fresh).toBe(0);
  });
});

describe("routesCached memo", () => {
  it("recomputes only when inputs or dependency versions move", () => {
    routeCache.clear();
    const p1 = mkPool(1, 50_000, 500_000_000);
    routeCache.notePools([p1]);
    let computes = 0;
    const compute = () => {
      computes += 1;
      return [mkRoute("best", 100)];
    };
    const run = (inputs: string) =>
      routesCached(compute, { key: "swap", poolIds: [1], inputsKey: inputs });

    const first = run("10");
    expect(computes).toBe(1);
    expect(first[0]!.amountOut).toBe(100);

    // Same inputs, same pool versions → memo hit, no recompute.
    const again = run("10");
    expect(computes).toBe(1);
    expect(again).toBe(first);

    // Inputs changed (different amount) → recompute.
    run("25");
    expect(computes).toBe(2);

    // Pool state changed → recompute even with same inputs.
    run("25");
    expect(computes).toBe(2);
    routeCache.notePools([mkPool(1, 40_000, 500_000_000)]);
    run("25");
    expect(computes).toBe(3);
  });
});
