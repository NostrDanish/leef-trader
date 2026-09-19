/**
 * P-A: findArb quotes Alcor CLMM pools over V3 virtual reserves (tick-price
 * anchored), falling back to raw reserves when the pool carries no CLMM
 * state (and always for Defibox/Taco true-CP books).
 *
 * Fixture: pool 217 (audit-verified, ALCOR_COMPARATIVE_AUDIT §3.3) at tick
 * price 25 858.7 LEEF/WAX next to a raw-CP book at 24 000 LEEF/WAX. Raw-CP
 * on pool 217 reads 40 542 and would hallucinate the arb direction.
 */
import { describe, expect, it } from "vitest";
import { findArb } from "./bot-engine";
import type { LeefPool, LeefSnapshot } from "./types";

function pool(over: {
  id: number;
  wax: number;
  leef: number;
  liquidity?: string;
  sqrtPriceX64?: string;
}): LeefPool {
  const { id, wax, leef, liquidity, sqrtPriceX64 } = over;
  return {
    id,
    fee: 3000,
    feePct: 0.3,
    leef: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: leef },
    pair: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: wax },
    leefIsA: false,
    tvlUsd: 10_000,
    volume24Usd: 500,
    volumeWeekUsd: 0,
    volumeUsdMonth: 0,
    volumeUsd90: 0,
    volumeLeef24: 0,
    volumePair24: 0,
    change24: 0,
    changeWeek: 0,
    liquidity: liquidity ?? "0",
    sqrtPriceX64,
    pairPerLeef: wax / leef,
    leefPerPair: leef / wax,
    waxPerLeef: wax / leef,
    usdPerLeef: null,
    tickSpacing: 60,
  };
}

const CLMM_217 = pool({
  id: 217,
  wax: 112_613.008,
  leef: 4_565_638_459,
  liquidity: "20077984976034",
  sqrtPriceX64: "29663563357779418305",
});

/** Raw-CP book at 24 000 LEEF/WAX (no CLMM state → raw reserves, exact CP). */
const RAW_BOOK = pool({ id: 218, wax: 20_000, leef: 480_000_000 });

function snap(pools: LeefPool[]): LeefSnapshot {
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    waxUsd: 0.02,
    leefUsd: 0.000002,
    waxPerLeef: 0.0001,
    pools,
    aux: [],
    trades: [],
    universe: [],
  };
}

describe("findArb virtual-reserve anchoring", () => {
  it("buys on the CLMM pool at its TICK price and sells on the raw book", () => {
    const plan = findArb(snap([CLMM_217, RAW_BOOK]), 10, 0.5)!;
    expect(plan).not.toBeNull();
    // Tick price 25 858.7 > 24 000: LEEF is cheaper on pool 217.
    expect(plan.buyPool.id).toBe(217);
    expect(plan.sellPool.id).toBe(218);
    // Virtual-CP round trip nets ≈ +7.0%; raw-CP on 217 would claim ≈ +68%.
    expect(plan.waxOut).toBeGreaterThan(10.5);
    expect(plan.waxOut).toBeLessThan(11);
    expect(plan.profitPct).toBeCloseTo(0.0703, 3);
  });

  it("does not hallucinate the reverse arb that raw-CP implies", () => {
    // With raw reserves pool 217 reads 40 542 LEEF/WAX, making the RAW book
    // look like the expensive one — the phantom direction loses ~7.8% live.
    const plan = findArb(snap([CLMM_217, RAW_BOOK]), 10, 0.5)!;
    expect(plan.sellPool.id).not.toBe(217);
  });

  it("falls back to raw reserves when the CLMM state is absent", () => {
    const stateless = pool({ id: 219, wax: 112_613.008, leef: 4_565_638_459 });
    // Both books now quote raw: 40 542 vs 24 000 — LEEF is cheapest on 219.
    const plan = findArb(snap([stateless, RAW_BOOK]), 10, 0.5)!;
    expect(plan).not.toBeNull();
    expect(plan.buyPool.id).toBe(219);
    expect(plan.sellPool.id).toBe(218);
  });
});
