import { describe, expect, it } from "vitest";
import { SEED_MAX_AGE_MS, seedToSnapshot } from "./seed";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");

function leefPoolRaw(id: number) {
  return {
    id,
    fee: 3000,
    active: true,
    tokenA: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: 1_000_000 },
    tokenB: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: 500 },
    priceA: 0.0005,
    priceB: 2000,
    tvlUSD: 120,
    volumeUSD24: 40,
  };
}

function waxStableRaw(id: number) {
  return {
    id,
    fee: 3000,
    active: true,
    tokenA: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: 100_000 },
    tokenB: { symbol: "WAXUSDC", contract: "eth.token", decimals: 6, quantity: 600 },
    priceA: 0.006,
    priceB: 166.7,
    tvlUSD: 1200,
    volumeUSD24: 500,
  };
}

function seedFile(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    fetchedAt: new Date(NOW - 5 * 60_000).toISOString(),
    leefUsdHint: 0.000003,
    pools: [leefPoolRaw(1), leefPoolRaw(2), waxStableRaw(99)],
    ...overrides,
  };
}

describe("seedToSnapshot", () => {
  it("converts a fresh seed into a fallback-sourced snapshot", () => {
    const snap = seedToSnapshot(seedFile(), NOW);
    expect(snap).not.toBeNull();
    expect(snap!.source).toBe("fallback");
    expect(snap!.warning).toBeUndefined();
    expect(snap!.pools).toHaveLength(2);
    expect(snap!.pools[0]!.pair.symbol).toBe("WAX");
    expect(snap!.fetchedAt).toBe(new Date(NOW - 5 * 60_000).toISOString());
  });

  it("prices USD from the WAX/stable anchor", () => {
    const snap = seedToSnapshot(seedFile(), NOW)!;
    expect(snap.waxUsd).toBeGreaterThan(0);
    expect(snap.leefUsd).toBeGreaterThan(0);
  });

  it("rejects a stale seed", () => {
    const stale = seedFile({
      fetchedAt: new Date(NOW - SEED_MAX_AGE_MS - 1).toISOString(),
    });
    expect(seedToSnapshot(stale, NOW)).toBeNull();
  });

  it("rejects a far-future seed (clock skew guard)", () => {
    const future = seedFile({ fetchedAt: new Date(NOW + 10 * 60_000).toISOString() });
    expect(seedToSnapshot(future, NOW)).toBeNull();
  });

  it("rejects malformed payloads", () => {
    expect(seedToSnapshot(null, NOW)).toBeNull();
    expect(seedToSnapshot({}, NOW)).toBeNull();
    expect(seedToSnapshot(seedFile({ pools: [] }), NOW)).toBeNull();
    expect(seedToSnapshot(seedFile({ pools: "nope" }), NOW)).toBeNull();
    expect(seedToSnapshot(seedFile({ pools: [{ id: 1 }] }), NOW)).toBeNull();
  });

  it("drops inactive pools from the seed", () => {
    const snap = seedToSnapshot(
      seedFile({ pools: [{ ...leefPoolRaw(1), active: false }, leefPoolRaw(2)] }),
      NOW,
    );
    expect(snap).not.toBeNull();
    expect(snap!.pools).toHaveLength(1);
    expect(snap!.pools[0]!.id).toBe(2);
  });
});
