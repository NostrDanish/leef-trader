/**
 * Regression: the route-level guaranteed output must come from
 * combineGuaranteedOut — split slices SUM their min-outs; hop chains take
 * the FINAL leg's min-out. A caller re-deriving this by hand got it wrong
 * (last-leg-only for splits), which understated the worst case 100+80 → 80.
 */
import { describe, expect, it } from "vitest";
import { combineGuaranteedOut } from "./quote-verify";

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
