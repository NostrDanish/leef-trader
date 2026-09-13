import { describe, expect, it } from "vitest";
import { normalizeTargets, planGrowthAction } from "./growth-engine";
import type { LeefPool, LeefSnapshot } from "./types";

const WAX_USD = 0.02;

function mkPool(waxReserve: number, leefReserve: number): LeefPool {
  const pairPerLeef = waxReserve / leefReserve;
  return {
    id: 1159,
    fee: 3000,
    feePct: 0.3,
    leef: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: leefReserve },
    pair: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: waxReserve },
    leefIsA: true,
    tvlUsd: waxReserve * WAX_USD * 2,
    volume24Usd: 50,
    volumeWeekUsd: 300,
    volumeUsdMonth: 1200,
    volumeUsd90: 3600,
    volumeLeef24: 0,
    volumePair24: 0,
    change24: 0,
    changeWeek: 0,
    liquidity: "0",
    pairPerLeef,
    leefPerPair: 1 / pairPerLeef,
    waxPerLeef: pairPerLeef,
    usdPerLeef: pairPerLeef * WAX_USD,
    tickSpacing: 60,
  };
}

function snap(): LeefSnapshot {
  const p = mkPool(50_000, 500_000_000);
  const leefUsd = (p.waxPerLeef ?? 0) * WAX_USD;
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    waxUsd: WAX_USD,
    leefUsd,
    waxPerLeef: p.waxPerLeef ?? 0,
    pools: [p],
    aux: [],
    trades: [],
    universe: [
      {
        symbol: "WAX",
        contract: "eosio.token",
        decimals: 8,
        alcorId: "wax-eosio.token",
        poolId: 0,
        waxPerToken: 1,
        usdPrice: WAX_USD,
        tvlUsd: 1_000_000,
        stable: false,
      },
      {
        symbol: "LEEF",
        contract: "leefmaincorp",
        decimals: 4,
        alcorId: "leef-leefmaincorp",
        poolId: 1159,
        waxPerToken: p.waxPerLeef ?? 0,
        usdPrice: leefUsd,
        tvlUsd: p.tvlUsd,
        stable: false,
      },
    ],
  };
}

describe("normalizeTargets", () => {
  it("defaults to LEEF and renormalizes weights", () => {
    expect(normalizeTargets([])[0]?.symbol).toBe("LEEF");
    const t = normalizeTargets([
      { symbol: "leef", weight: 2 },
      { symbol: "tlm", weight: 1 },
    ]);
    expect(t).toHaveLength(2);
    expect(t[0]!.weight + t[1]!.weight).toBeCloseTo(100, 6);
  });
});

describe("planGrowthAction", () => {
  it("HOLDs on an empty wallet and explains why", () => {
    const r = planGrowthAction(snap(), {}, {
      targets: [{ symbol: "LEEF", weight: 100 }],
      mode: "balanced",
      minUsd: 0,
      maxUsd: 1,
    });
    expect("hold" in r).toBe(true);
    if ("hold" in r) expect(r.hold).toMatch(/HOLD/);
  });
});
