/**
 * Regression: the route-level guaranteed output must come from
 * combineGuaranteedOut — split slices SUM their min-outs; hop chains take
 * the FINAL leg's min-out. A caller re-deriving this by hand got it wrong
 * (last-leg-only for splits), which understated the worst case 100+80 → 80.
 */
import { describe, expect, it } from "vitest";
import { combineGuaranteedOut } from "./quote-verify";
import { exactSwapVerdict } from "./exact-gate";
import type { LeefSnapshot, SwapRoute } from "./types";

const WAX_USD = 0.02;

function snap(): LeefSnapshot {
  const leefUsd = 0.0001 * WAX_USD;
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    waxUsd: WAX_USD,
    leefUsd,
    waxPerLeef: 0.0001,
    pools: [],
    aux: [],
    trades: [],
    universe: [
      {
        symbol: "WAX", contract: "eosio.token", decimals: 8, alcorId: "wax-eosio.token",
        poolId: 0, waxPerToken: 1, usdPrice: WAX_USD, tvlUsd: 1_000_000, stable: false,
      },
      {
        symbol: "LEEF", contract: "leefmaincorp", decimals: 4, alcorId: "leef-leefmaincorp",
        poolId: 1159, waxPerToken: 0.0001, usdPrice: leefUsd, tvlUsd: 50_000, stable: false,
      },
    ],
  };
}

function route(amountIn: number, amountOut: number): SwapRoute {
  return {
    id: "t", kind: "direct", label: "t", poolIds: [1159],
    legs: [{ poolId: 1159, pairName: "t", tokenIn: "WAX", tokenOut: "LEEF", amountIn, amountOut, feePct: 0.3, priceImpact: 0.001 }],
    amountIn, amountOut, tokenIn: "WAX", tokenOut: "LEEF",
    feePct: 0.3, priceImpact: 0.001, executionPrice: amountOut / amountIn,
    spotPrice: amountOut / amountIn, vsBestPct: 0, tvlUsd: 50_000, volume24Usd: 100, notes: [],
  };
}

describe("combineGuaranteedOut", () => {
  it("split route: guaranteed = SUM of leg min-outs", () => {
    const legs = [{ minOut: 100 }, { minOut: 80 }];
    expect(combineGuaranteedOut(legs, true)).toBe(180);
  });

  it("hop chain: guaranteed = final leg min-out (legs chain on guarantees)", () => {
    const legs = [{ minOut: 98.7 }, { minOut: 96.2 }];
    expect(combineGuaranteedOut(legs, false)).toBe(96.2);
  });

  it("single leg works for both shapes", () => {
    const legs = [{ minOut: 42.5 }];
    expect(combineGuaranteedOut(legs, true)).toBe(42.5);
    expect(combineGuaranteedOut(legs, false)).toBe(42.5);
  });

  it("empty route guarantees nothing", () => {
    expect(combineGuaranteedOut([], true)).toBe(0);
    expect(combineGuaranteedOut([], false)).toBe(0);
  });

  it("three-way split sums all three", () => {
    const legs = [{ minOut: 10 }, { minOut: 20 }, { minOut: 30 }];
    expect(combineGuaranteedOut(legs, true)).toBe(60);
  });
});

describe("exactSwapVerdict floor tolerance", () => {
  it("guaranteed below floor FAILS by default — the floor is a floor", () => {
    // exact +0.5%, but guaranteed (min-out) −0.1% vs a 0% floor.
    const v = exactSwapVerdict({
      snap: snap(),
      route: route(100, 100.5 * 10_000),
      amountIn: 100,
      expectedOut: 100.5 * 10_000,
      guaranteedOut: 99.9 * 10_000,
      minNetPct: 0,
    });
    expect(v.pass).toBe(false);
  });

  it("explicit tolerance parameter allows the stated dip only", () => {
    const opts = {
      snap: snap(),
      route: route(100, 100.5 * 10_000),
      amountIn: 100,
      expectedOut: 100.5 * 10_000,
      guaranteedOut: 99.9 * 10_000,
      minNetPct: 0,
    };
    expect(exactSwapVerdict({ ...opts, floorTolerancePct: 0.2 }).pass).toBe(true);
    expect(exactSwapVerdict({ ...opts, floorTolerancePct: 0.05 }).pass).toBe(false);
  });
});
