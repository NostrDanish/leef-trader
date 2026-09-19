import { describe, expect, it } from "vitest";
import {
  isLeefToken,
  isWaxToken,
  quoteConstantProduct,
  virtualLeefPairReserves,
  virtualReserves,
} from "./amm";

/**
 * Token identity is contract + symbol + precision — never a symbol alone.
 * These tests pin the fail-closed behavior: a spoofed "LEEF" or "WAX" on a
 * foreign contract must never feed pricing, routing, arb scans or signing.
 */
describe("token identity", () => {
  it("accepts only canonical LEEF (leefmaincorp)", () => {
    expect(isLeefToken({ symbol: "LEEF", contract: "leefmaincorp" })).toBe(true);
    // Symbol matching is case-insensitive; the contract is not negotiable.
    expect(isLeefToken({ symbol: "leef", contract: "leefmaincorp" })).toBe(true);
  });

  it("rejects LEEF on any other contract", () => {
    expect(isLeefToken({ symbol: "LEEF", contract: "token.leef" })).toBe(false);
    expect(isLeefToken({ symbol: "LEEF", contract: "fake.contract" })).toBe(false);
    expect(isLeefToken({ symbol: "LEEF", contract: "eosio.token" })).toBe(false);
  });

  it("rejects LEEF with a missing contract", () => {
    expect(isLeefToken({ symbol: "LEEF", contract: "" })).toBe(false);
    expect(isLeefToken({ symbol: "LEEF" })).toBe(false);
    expect(isLeefToken({})).toBe(false);
  });

  it("rejects near-miss symbols on the real contract", () => {
    expect(isLeefToken({ symbol: "LEEFX", contract: "leefmaincorp" })).toBe(false);
    expect(isLeefToken({ symbol: "LEE", contract: "leefmaincorp" })).toBe(false);
  });

  it("accepts only canonical WAX (eosio.token)", () => {
    expect(isWaxToken({ symbol: "WAX", contract: "eosio.token" })).toBe(true);
  });

  it("rejects WAX without the eosio.token contract", () => {
    expect(isWaxToken({ symbol: "WAX", contract: "" })).toBe(false);
    expect(isWaxToken({ symbol: "WAX" })).toBe(false);
    expect(isWaxToken({ symbol: "WAX", contract: "fake.token" })).toBe(false);
    expect(isWaxToken({})).toBe(false);
  });
});

describe("quoteConstantProduct", () => {
  it("returns zero for empty markets or amounts", () => {
    expect(quoteConstantProduct(0, 1000, 1000, 3000).amountOut).toBe(0);
    expect(quoteConstantProduct(10, 0, 1000, 3000).amountOut).toBe(0);
    expect(quoteConstantProduct(10, 1000, 0, 3000).amountOut).toBe(0);
  });

  it("charges the fee and reports impact", () => {
    // fee 3000 = 0.30% in Alcor fee units.
    const q = quoteConstantProduct(1000, 100_000, 1_000_000, 3000);
    expect(q.feePaid).toBeCloseTo(3, 10);
    // 997 after fee against 100k/1M reserves ≈ 9871.6 out.
    expect(q.amountOut).toBeGreaterThan(9800);
    expect(q.amountOut).toBeLessThan(9970);
    expect(q.priceImpact).toBeGreaterThan(0);
    expect(q.priceImpact).toBeLessThan(0.02);
    expect(q.spotPrice).toBeCloseTo(10, 10);
  });
});

/**
 * Pool 217 fixture (main WAX/LEEF, fee 3000) verified on-chain and against
 * the Alcor API at audit time (ALCOR_COMPARATIVE_AUDIT §3.3 + appendix):
 * tokenA = WAX (8 decimals), tokenB = LEEF (4 decimals), tick 9501.
 */
const POOL217 = {
  sqrtPriceX64: "29663563357779418305",
  liquidity: "20077984976034",
  wax: 112_613.008,
  leef: 4_565_638_459,
  /** Tick price: 25 858.7 LEEF per WAX. Raw-reserve CP says 40 542 — the bug. */
  tickPrice: 25_858.7,
};

describe("virtualReserves", () => {
  it("computes the V3 virtual reserves (rx = L·2⁶⁴/√P, ry = L·√P/2⁶⁴)", () => {
    const v = virtualReserves(POOL217)!;
    expect(v).not.toBeNull();
    // Audit-measured human equivalents: ≈124 858 WAX / ≈3 228 900 000 LEEF.
    expect(Number(v.rx) / 1e8).toBeCloseTo(124_858, 0);
    expect(Number(v.ry) / 1e4).toBeCloseTo(3_228_670_475, -4);
  });

  it("returns null when liquidity or sqrtPriceX64 is missing or non-positive", () => {
    expect(virtualReserves({ liquidity: "0", sqrtPriceX64: POOL217.sqrtPriceX64 })).toBeNull();
    expect(virtualReserves({ liquidity: POOL217.liquidity })).toBeNull();
    expect(virtualReserves({ sqrtPriceX64: POOL217.sqrtPriceX64 })).toBeNull();
    expect(virtualReserves({ liquidity: "abc", sqrtPriceX64: "xyz" })).toBeNull();
    expect(virtualReserves({ liquidity: "-5", sqrtPriceX64: POOL217.sqrtPriceX64 })).toBeNull();
  });

  it("anchors CP spot at the tick price, not the raw reserve ratio", () => {
    // leefIsA = false: tokenA = WAX, tokenB = LEEF.
    const v = virtualLeefPairReserves({
      liquidity: POOL217.liquidity,
      sqrtPriceX64: POOL217.sqrtPriceX64,
      leefIsA: false,
      leef: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: POOL217.leef },
      pair: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: POOL217.wax },
    })!;
    expect(v).not.toBeNull();
    const spotVirtual = v.leef / v.pair;
    const spotRaw = POOL217.leef / POOL217.wax;
    expect(spotRaw).toBeCloseTo(40_542.7, 1); // the level error, pinned
    expect(spotVirtual).toBeCloseTo(POOL217.tickPrice, 0);
    // Marginal CP quote (a tiny WAX→LEEF buy) lands on the tick price.
    const q = quoteConstantProduct(0.001, v.pair, v.leef, 3000);
    expect(q.spotPrice).toBeCloseTo(POOL217.tickPrice, 0);
  });
});
