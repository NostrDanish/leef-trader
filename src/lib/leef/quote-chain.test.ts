import { describe, expect, it } from "vitest";
import type { QuoteLeg, SwapRoute } from "./types";
import { verifiedLegInput, type VerifiedLeg } from "./quote-verify";

function leg(amountIn: number, amountOut: number): QuoteLeg {
  return {
    poolId: 1,
    pairName: "test",
    tokenIn: "A",
    tokenOut: "B",
    amountIn,
    amountOut,
    feePct: 0.3,
    priceImpact: 0.01,
    venue: "alcor",
  };
}

function route(kind: SwapRoute["kind"], legs: QuoteLeg[]): Pick<SwapRoute, "kind" | "legs"> {
  return { kind, legs };
}

describe("fresh mixed-route amount chaining", () => {
  it("uses the previous freshly guaranteed min-out for a hop", () => {
    const r = route("hop", [leg(10, 100), leg(100, 90)]);
    const verified: VerifiedLeg[] = [
      { venue: "alcor", trust: "executable", amountIn: 10, amountOut: 83, minOut: 82 },
    ];
    expect(verifiedLegInput(r, 10, verified, 0)).toBe(10);
    // Modeled second-leg input was 100; fresh first quote expects 83 but
    // guarantees only 82. The second action may safely spend 82.
    expect(verifiedLegInput(r, 10, verified, 1)).toBe(82);
  });

  it("keeps split slices independent instead of chaining them", () => {
    const r = route("split", [leg(6, 60), leg(4, 42)]);
    const verified: VerifiedLeg[] = [
      { venue: "alcor", trust: "executable", amountIn: 6, amountOut: 55, minOut: 54 },
    ];
    expect(verifiedLegInput(r, 10, verified, 0)).toBe(6);
    expect(verifiedLegInput(r, 10, verified, 1)).toBe(4);
  });

  it("fails closed when a previous hop produced no verified output", () => {
    const r = route("hop", [leg(10, 100), leg(100, 90)]);
    expect(verifiedLegInput(r, 10, [], 1)).toBe(0);
  });
});
