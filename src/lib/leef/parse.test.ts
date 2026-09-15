/**
 * Regression: WAX/USD from a CLMM pool must come from the venue's spot
 * price (priceA/priceB or sqrtPriceX64), never the raw reserve ratio.
 * Concentrated liquidity skews holdings: the pool can hold twice as much
 * stable per WAX as the spot implies — that printed WAX ≈ $0.0093 when the
 * real book said $0.00507.
 */
import { describe, expect, it } from "vitest";
import { attachUsdPrices, parseAllPools, waxUsdAnchor, waxUsdFromAux } from "./parse";
import type { AuxPool } from "./types";

const WAX = { symbol: "WAX", contract: "eosio.token", decimals: 8 };
const WAXUSDC = { symbol: "WAXUSDC", contract: "eth.token", decimals: 6 };

function clmmWaxUsdcPool(over: Partial<AuxPool> = {}): AuxPool {
  return {
    id: 1213,
    fee: 3000,
    feePct: 0.3,
    // Reserves imply ~$0.0093 per WAX — liquidity concentrated off-spot.
    tokenA: { ...WAX, quantity: 100_000 },
    tokenB: { ...WAXUSDC, quantity: 930 },
    tvlUsd: 50_000,
    volume24Usd: 1_000,
    // The venue's CLMM-aware spot price: the truth.
    priceA: 0.00507,
    priceB: 197.2,
    ...over,
  };
}

describe("attachUsdPrices — CLMM WAX/stable pricing", () => {
  it("prefers the venue spot price over the reserve ratio", () => {
    const { waxUsd } = attachUsdPrices([], [clmmWaxUsdcPool()]);
    expect(waxUsd).toBeCloseTo(0.00507, 8);
  });

  it("uses sqrtPriceX64 when priceA/priceB are absent", () => {
    // spot 0.00507 USDC(6dp) per WAX(8dp): sqrtP² × 10^(8−6) = 0.00507
    const sqrtP = Math.sqrt(0.00507 / 100);
    const x64 = BigInt(Math.round(sqrtP * 2 ** 64));
    const { waxUsd } = attachUsdPrices(
      [],
      [clmmWaxUsdcPool({ priceA: undefined, priceB: undefined, sqrtPriceX64: x64.toString() })],
    );
    expect(waxUsd).toBeCloseTo(0.00507, 4);
  });

  it("falls back to reserves only when no spot price exists", () => {
    const { waxUsd } = attachUsdPrices(
      [],
      [clmmWaxUsdcPool({ priceA: undefined, priceB: undefined, sqrtPriceX64: undefined })],
    );
    expect(waxUsd).toBeCloseTo(0.0093, 6);
  });

  it("flips orientation when WAX is tokenB", () => {
    const pool = clmmWaxUsdcPool({
      tokenA: { ...WAXUSDC, quantity: 930 },
      tokenB: { ...WAX, quantity: 100_000 },
      priceA: 197.2, // WAX per WAXUSDC
      priceB: 0.00507, // WAXUSDC per WAX
      sqrtPriceX64: undefined,
    });
    const { waxUsd } = attachUsdPrices([], [pool]);
    expect(waxUsd).toBeCloseTo(0.00507, 8);
  });

  it("anchors on the DEEPEST WAX/stable pool, not the first in array order", () => {
    const junk = clmmWaxUsdcPool({ id: 1, tvlUsd: 10, priceA: 0.0093, priceB: 1 / 0.0093 });
    const real = clmmWaxUsdcPool({ id: 2, tvlUsd: 250_000, priceA: 0.00507, priceB: 197.2 });
    // Junk first in the array — the old .find() would anchor on it.
    expect(waxUsdFromAux([junk, real])).toBeCloseTo(0.00507, 8);
    expect(waxUsdFromAux([real, junk])).toBeCloseTo(0.00507, 8);
  });

  it("a deep DEPEGGED-stable pool cannot move the anchor when the pack disagrees", () => {
    // The flip-to-0.009 bug: a WAX/PARAUSD-style book whose stable trades at
    // ~$0.55 implies WAX ≈ $0.009 — deep enough to win the old deepest-TVL
    // anchor, wrong enough to poison the whole snapshot.
    const realA = clmmWaxUsdcPool({ id: 2, tvlUsd: 250_000, priceA: 0.00507, priceB: 197.2 });
    const realB = clmmWaxUsdcPool({ id: 3, tvlUsd: 120_000, priceA: 0.00511, priceB: 195.7 });
    const depegged = clmmWaxUsdcPool({
      id: 4,
      tokenB: { symbol: "PARAUSD", contract: "parareserves", decimals: 6, quantity: 500 },
      tvlUsd: 400_000, // deepest — and wrong
      priceA: 0.0093,
      priceB: 1 / 0.0093,
    });
    // Median of [0.00507, 0.00511, 0.0093] is 0.00511 — the depeg is an outlier.
    expect(waxUsdFromAux([depegged, realA, realB])).toBeCloseTo(0.00511, 8);
    expect(waxUsdFromAux([realB, depegged, realA])).toBeCloseTo(0.00511, 8);
  });

  it("venue-native spot ALWAYS outranks a reserve-ratio book (the reload-then-flip bug)", () => {
    // Alcor spot says 0.00507. A Defibox-style reserve book (CP math, or a
    // misread table) implies 0.0093 and is deeper. First paint was right,
    // then the venue merge flipped it — reserve books must never override
    // a venue-quoted spot.
    const alcorSpot = clmmWaxUsdcPool({ id: 2, tvlUsd: 40_000, priceA: 0.00507, priceB: 197.2 });
    const venueReserve = clmmWaxUsdcPool({
      id: 1_000_001,
      tvlUsd: 900_000,
      venue: "defibox",
      priceA: undefined,
      priceB: undefined,
      sqrtPriceX64: undefined,
      tokenA: { ...WAX, quantity: 100_000 },
      tokenB: { symbol: "WAXUSDC", contract: "eth.token", decimals: 6, quantity: 930 },
    });
    expect(waxUsdFromAux([alcorSpot, venueReserve])).toBeCloseTo(0.00507, 8);
    expect(waxUsdFromAux([venueReserve, alcorSpot])).toBeCloseTo(0.00507, 8);
  });

  it("reserve books anchor only when no venue spot exists", () => {
    const venueReserve = clmmWaxUsdcPool({
      id: 1_000_001,
      venue: "defibox",
      priceA: undefined,
      priceB: undefined,
      sqrtPriceX64: undefined,
      tokenA: { ...WAX, quantity: 100_000 },
      tokenB: { symbol: "WAXUSDC", contract: "eth.token", decimals: 6, quantity: 507 },
    });
    expect(waxUsdFromAux([venueReserve])).toBeCloseTo(0.00507, 8);
  });
});

describe("waxUsdAnchor — observation set quality", () => {
  it("one observation can never be confident", () => {
    const a = waxUsdAnchor([clmmWaxUsdcPool()]);
    expect(a).not.toBeNull();
    expect(a!.sources).toBe(1);
    expect(a!.confidence).toBeLessThan(0.5);
  });

  it("three tight observations = high confidence, low dispersion", () => {
    const a = waxUsdAnchor([
      clmmWaxUsdcPool({ id: 1, priceA: 0.00507, priceB: 197.2 }),
      clmmWaxUsdcPool({ id: 2, priceA: 0.00509, priceB: 196.5 }),
      clmmWaxUsdcPool({ id: 3, priceA: 0.00506, priceB: 197.6 }),
    ]);
    expect(a!.sources).toBe(3);
    expect(a!.spotSources).toBe(3);
    expect(a!.dispersionPct).toBeLessThan(1);
    expect(a!.confidence).toBeGreaterThan(0.9);
  });

  it("wide disagreement caps confidence low even with many sources", () => {
    const a = waxUsdAnchor([
      clmmWaxUsdcPool({ id: 1, priceA: 0.005, priceB: 200 }),
      clmmWaxUsdcPool({ id: 2, priceA: 0.006, priceB: 166.7 }),
      clmmWaxUsdcPool({ id: 3, priceA: 0.0093, priceB: 107.5 }),
    ]);
    expect(a!.confidence).toBeLessThanOrEqual(0.4);
  });
});
    expect(waxUsdFromAux([venueReserve])).toBeCloseTo(0.00507, 8);
  });

  it("ignores WAX pools against untrusted stables", () => {
    const fake = clmmWaxUsdcPool({
      tokenB: { symbol: "WAXUSDC", contract: "fake.contract", decimals: 6, quantity: 930 },
      priceA: 0.02,
      priceB: 50,
    });
    expect(waxUsdFromAux([fake])).toBe(0);
  });
});

describe("attachUsdPrices — hint is a fallback, never a freeze", () => {
  it("fresh book math overrides the hint (regression: on-chain refresh froze a bad first load forever)", () => {
    const pool = clmmWaxUsdcPool();
    const { waxUsd } = attachUsdPrices([], [pool], 0.0093); // stale hint
    expect(waxUsd).toBeCloseTo(0.00507, 8);
  });

  it("hint survives only when the book has no WAX/stable pool", () => {
    const { waxUsd } = attachUsdPrices([], [], 0.00507);
    expect(waxUsd).toBeCloseTo(0.00507, 8);
  });
});

describe("parseAllPools — aux pools keep venue spot prices", () => {
  it("parses priceA/priceB/sqrtPriceX64 onto aux pools", () => {
    const { aux } = parseAllPools([
      {
        id: 1213,
        fee: 3000,
        tvlUSD: 50000,
        tokenA: { ...WAX, quantity: 100000 },
        tokenB: { ...WAXUSDC, quantity: 930 },
        priceA: 0.00507,
        priceB: 197.2,
        sqrtPriceX64: "12345",
      },
    ]);
    expect(aux).toHaveLength(1);
    expect(aux[0]!.priceA).toBeCloseTo(0.00507, 8);
    expect(aux[0]!.priceB).toBeCloseTo(197.2, 6);
    expect(aux[0]!.sqrtPriceX64).toBe("12345");
  });
});
