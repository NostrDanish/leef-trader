import { describe, expect, it } from "vitest";
import type { LeefPool } from "@/lib/leef/types";
import {
  applyOnchainToLeefPool,
  idRanges,
  onchainDiffers,
  parseOnchainPool,
} from "./alcor-onchain";

/**
 * Row shape straight from swap.alcor's `pools` table (get_table_rows), as
 * consumed by Alcor's own v2 SDK: currSlot.sqrtPriceX64 + currSlot.tick.
 * sqrtPriceX64 "45802571509710763" is a real WAX/USDT observation —
 * price(A=WAX, dec 8) in B(USDT, dec 4) ≈ 0.0616.
 */
const WAX_USDT_ROW = {
  id: 1095,
  active: true,
  fee: 3000,
  tickSpacing: 60,
  liquidity: "951789470700",
  currSlot: { sqrtPriceX64: "45802571509710763", tick: -119973 },
  tokenA: { quantity: "1413257.13064633 WAX", contract: "eosio.token" },
  tokenB: { quantity: "81673.5964 USDT", contract: "usdt.alcor" },
};

const LEEF_WAX_ROW = {
  id: 217,
  active: true,
  fee: 3000,
  tickSpacing: 60,
  liquidity: "424242",
  currSlot: { sqrtPriceX64: "12345000000000000", tick: -88490 },
  tokenA: { quantity: "900000000.0000 LEEF", contract: "leefmaincorp" },
  tokenB: { quantity: "45000.00000000 WAX", contract: "eosio.token" },
};

describe("parseOnchainPool (swap.alcor table rows)", () => {
  it("parses tokens, decimals, currSlot and computes the A-in-B price", () => {
    const p = parseOnchainPool(WAX_USDT_ROW);
    expect(p).not.toBeNull();
    expect(p!.tokenA).toEqual({
      symbol: "WAX",
      contract: "eosio.token",
      decimals: 8,
      quantity: 1_413_257.13064633,
    });
    expect(p!.tokenB).toEqual({
      symbol: "USDT",
      contract: "usdt.alcor",
      decimals: 4,
      quantity: 81_673.5964,
    });
    expect(p!.tick).toBe(-119973);
    expect(p!.priceAInB).toBeGreaterThan(0.05);
    expect(p!.priceAInB).toBeLessThan(0.08); // ≈ 0.0616 USDT per WAX
  });

  it("inactive rows are rejected (dead books misquote routes)", () => {
    expect(parseOnchainPool({ ...LEEF_WAX_ROW, active: false })).not.toBeNull(); // parsed, but…
    const pool = applyOnchainToLeefPool(mkLeefPool(), parseOnchainPool({ ...LEEF_WAX_ROW, active: false })!);
    expect(pool).toBeNull(); // …never applied to the local book
  });
});

describe("idRanges (small contiguous reads, not full-table scans)", () => {
  it("groups clustered ids and splits on gaps", () => {
    expect(idRanges([4, 5, 6, 9, 217])).toEqual([
      { lower: 4, upper: 9 },
      { lower: 217, upper: 217 },
    ]);
    expect(idRanges([])).toEqual([]);
    expect(idRanges([1095])).toEqual([{ lower: 1095, upper: 1095 }]);
  });
});

describe("applyOnchainToLeefPool (chain truth patches the local book)", () => {
  it("refreshes reserves and keeps orientation honest (reserve-priced row)", () => {
    const local = mkLeefPool();
    const oc = parseOnchainPool({
      ...LEEF_WAX_ROW,
      currSlot: { sqrtPriceX64: "0", tick: -88500 },
      tokenA: { quantity: "950000000.0000 LEEF", contract: "leefmaincorp" },
      tokenB: { quantity: "47000.00000000 WAX", contract: "eosio.token" },
    })!;
    const patched = applyOnchainToLeefPool(local, oc);
    expect(patched).not.toBeNull();
    expect(patched!.leef.quantity).toBe(950_000_000);
    expect(patched!.pair.quantity).toBe(47_000);
    // LEEF is tokenA → pairPerLeef = B per A = WAX per LEEF from reserves.
    expect(patched!.pairPerLeef).toBeCloseTo(47_000 / 950_000_000, 15);
    expect(patched!.waxPerLeef).toBeCloseTo(47_000 / 950_000_000, 15);
  });

  it("prefers the on-chain sqrt price when the row carries one", () => {
    // sqrtPriceX64 = 2^64 with equal decimals ⇒ raw price 1 ⇒ 1 WAX per LEEF.
    const SQRT_ONE = (1n << 64n).toString();
    const local = mkLeefPool();
    const oc = parseOnchainPool({
      ...LEEF_WAX_ROW,
      currSlot: { sqrtPriceX64: SQRT_ONE, tick: -88490 },
      tokenA: { quantity: "100.0000 LEEF", contract: "leefmaincorp" },
      tokenB: { quantity: "100.0000 WAX", contract: "eosio.token" },
    })!;
    expect(oc.tokenA.decimals).toBe(4);
    expect(oc.tokenB.decimals).toBe(4);
    expect(oc.priceAInB).toBeCloseTo(1, 12);
    const patched = applyOnchainToLeefPool(local, oc);
    expect(patched).not.toBeNull();
    expect(patched!.sqrtPriceX64).toBe(SQRT_ONE);
    expect(patched!.pairPerLeef).toBeCloseTo(1, 12);
  });

  it("b-pools (LEEF as tokenB) invert the price correctly", () => {
    const local = mkLeefPool({ leefIsA: false });
    const oc = parseOnchainPool({
      ...LEEF_WAX_ROW,
      currSlot: { sqrtPriceX64: "0", tick: -88500 },
      tokenA: { quantity: "47000.00000000 WAX", contract: "eosio.token" },
      tokenB: { quantity: "950000000.0000 LEEF", contract: "leefmaincorp" },
    })!;
    const patched = applyOnchainToLeefPool(local, oc);
    expect(patched).not.toBeNull();
    expect(patched!.pairPerLeef).toBeCloseTo(47_000 / 950_000_000, 15);
  });
});

describe("onchainDiffers", () => {
  it("detects sqrt/liquidity/reserve movement", () => {
    const oc = parseOnchainPool(LEEF_WAX_ROW)!;
    const base = {
      sqrtPriceX64: "12345000000000000",
      liquidity: "424242",
      qtyA: 900_000_000,
      qtyB: 45_000,
    };
    expect(onchainDiffers(base, oc)).toBe(false);
    expect(onchainDiffers({ ...base, sqrtPriceX64: "999" }, oc)).toBe(true);
    expect(onchainDiffers({ ...base, liquidity: "1" }, oc)).toBe(true);
    expect(onchainDiffers({ ...base, qtyA: 901_000_000 }, oc)).toBe(true);
    expect(onchainDiffers({ ...base, qtyB: 45_001 }, oc)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

function mkLeefPool(over: Partial<LeefPool> = {}): LeefPool {
  const pairPerLeef = 45_000 / 900_000_000;
  return {
    id: 217,
    fee: 3000,
    feePct: 0.3,
    leef: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: 900_000_000 },
    pair: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: 45_000 },
    leefIsA: true,
    tvlUsd: 3_600,
    volume24Usd: 10,
    volumeWeekUsd: 0,
    volumeUsdMonth: 0,
    volumeUsd90: 0,
    volumeLeef24: 0,
    volumePair24: 0,
    change24: 0,
    changeWeek: 0,
    liquidity: "424242",
    pairPerLeef,
    leefPerPair: 1 / pairPerLeef,
    waxPerLeef: pairPerLeef,
    usdPerLeef: pairPerLeef * 0.04,
    sqrtPriceX64: "12345000000000000",
    tickSpacing: 60,
    ...over,
  };
}
