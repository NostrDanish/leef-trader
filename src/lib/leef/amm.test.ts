import { describe, expect, it } from "vitest";
import { isLeefToken, isWaxToken, quoteConstantProduct } from "./amm";

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
