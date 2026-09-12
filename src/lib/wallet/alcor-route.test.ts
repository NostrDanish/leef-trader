import { describe, expect, it } from "vitest";
import { formatAlcorSlippageParam } from "./alcor-route";

/**
 * Alcor's getRoute handler:
 *   slippage = slippage ? new Percent(parseFloat(slippage) * 100, 10000) : …
 * JSBI.BigInt throws unless `parseFloat(slippage) * 100` is an exact integer.
 * The outer catch then returns HTTP 500 "Internal error".
 *
 * These cases were reproduced live against wax.alcor.exchange on 2026-09-12.
 */
function alcorAccepts(param: string): boolean {
  const n = parseFloat(param);
  return Number.isFinite(n) && Number.isInteger(n * 100);
}

describe("formatAlcorSlippageParam", () => {
  it("encodes values Alcor 500s on (1.1, 0.55, 2.2) as integer-hundredths", () => {
    for (const raw of [1.1, 0.55, 2.2, 2.3, 0.29, 0.14, 4.35, 0.125, 1.15]) {
      const s = formatAlcorSlippageParam(raw);
      expect(alcorAccepts(s)).toBe(true);
      expect(Number(s)).toBeLessThanOrEqual(raw + 1e-12);
      expect(Number(s)).toBeGreaterThanOrEqual(0.05);
    }
  });

  it("keeps already-safe values (0.6, 0.8, 1.0, 1.2)", () => {
    expect(formatAlcorSlippageParam(0.6)).toBe("0.60");
    expect(formatAlcorSlippageParam(0.8)).toBe("0.80");
    expect(formatAlcorSlippageParam(1)).toBe("1.00");
    expect(formatAlcorSlippageParam(1.2)).toBe("1.20");
    expect(formatAlcorSlippageParam(0.05)).toBe("0.05");
  });

  it("never widens the caller's guard", () => {
    // 1.1 → walk down to 1.05 (1.05*100 = 105 exactly), not 1.15 or 1.2
    expect(Number(formatAlcorSlippageParam(1.1))).toBeLessThanOrEqual(1.1);
    expect(Number(formatAlcorSlippageParam(1.1))).toBeGreaterThanOrEqual(1.0);
    expect(Number(formatAlcorSlippageParam(0.55))).toBeLessThanOrEqual(0.55);
  });

  it("floors invalid / tiny inputs at 0.05", () => {
    expect(formatAlcorSlippageParam(0)).toBe("0.05");
    expect(formatAlcorSlippageParam(-1)).toBe("0.05");
    expect(formatAlcorSlippageParam(NaN)).toBe("0.05");
    expect(formatAlcorSlippageParam(0.001)).toBe("0.05");
  });

  it("encodes the arb re-quote path (slipMax * 0.9) without IEEE leftovers", () => {
    // Typical floor-tightening: 0.6 * 0.9 = 0.54; 0.54*100 = 54 exactly → ok
    // 1.1 * 0.9 = 0.9900000000000001 → must still encode as an integer hundredths
    const s = formatAlcorSlippageParam(Math.min(1.1, 0.6 * 0.9));
    expect(alcorAccepts(s)).toBe(true);
    const s2 = formatAlcorSlippageParam(0.30000000000000004);
    expect(alcorAccepts(s2)).toBe(true);
    expect(Number(s2)).toBeLessThanOrEqual(0.3 + 1e-12);
  });
});
