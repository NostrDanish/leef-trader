/**
 * Market-aware rebalance sizing tests — the $20-into-a-thin-pool problem.
 * Synthetic impact curves prove the decision logic without a live book.
 */
import { describe, expect, it } from "vitest";
import {
  candidateSizesUsd,
  chooseRebalanceSize,
  rebalanceImpactBudgetPct,
} from "./rebalance-sizing";

/** Deep book: impact grows linearly and slowly. */
const deepBook = (sizeUsd: number) => ({ impactPct: sizeUsd * 0.012, costPct: sizeUsd * 0.012 + 0.3 });

/** Thin LEEF book: impact grows superlinearly — 0.3%×√scaled knee. */
const thinBook = (sizeUsd: number) => {
  const impact = 0.25 * Math.pow(sizeUsd, 1.4);
  return { impactPct: impact, costPct: impact + 0.35 };
};

describe("chooseRebalanceSize", () => {
  it("deep liquidity: a $20 gap executes FULL", () => {
    const d = chooseRebalanceSize({
      gapUsd: 20,
      minUsd: 1,
      maxUsd: 20,
      budgetPct: 1.0,
      quoteAt: deepBook, // $20 → 0.24% impact
    });
    expect(d.action).toBe("EXECUTE_FULL");
    expect(d.sizeUsd).toBeCloseTo(20, 6);
    expect(d.remainingUsd).toBe(0);
  });

  it("thin book: a $20 gap executes PARTIAL at the budget knee", () => {
    // thinBook: $1→0.25%, $2→0.66%, $5→2.39%, $10→6.3%… budget 1% →
    // largest viable is $2 (0.66%) — $5 would be 2.39%.
    const d = chooseRebalanceSize({
      gapUsd: 20,
      minUsd: 1,
      maxUsd: 20,
      budgetPct: 1.0,
      quoteAt: thinBook,
    });
    expect(d.action).toBe("EXECUTE_PARTIAL");
    expect(d.sizeUsd).toBe(2);
    expect(d.remainingUsd).toBeCloseTo(18, 6);
    expect(d.reason).toContain("partial");
  });

  it("hostile book: even the smallest size over budget → WAIT, no order", () => {
    const d = chooseRebalanceSize({
      gapUsd: 20,
      minUsd: 1,
      maxUsd: 20,
      budgetPct: 0.5,
      quoteAt: (s) => ({ impactPct: 1.1 * s, costPct: 2 }), // $1 → 1.1% > 0.5%
    });
    expect(d.action).toBe("WAIT");
    expect(d.sizeUsd).toBe(0);
    expect(d.reason).toContain("WAIT");
  });

  it("no gap or no capacity → NO_ACTION", () => {
    expect(
      chooseRebalanceSize({ gapUsd: 0, minUsd: 1, maxUsd: 20, budgetPct: 1, quoteAt: deepBook }).action,
    ).toBe("NO_ACTION");
    expect(
      chooseRebalanceSize({ gapUsd: 20, minUsd: 5, maxUsd: 4, budgetPct: 1, quoteAt: deepBook }).action,
    ).toBe("NO_ACTION");
  });

  it("unquotable sizes are skipped, and the biggest VIABLE size wins", () => {
    const d = chooseRebalanceSize({
      gapUsd: 50,
      minUsd: 1,
      maxUsd: 50,
      budgetPct: 1.0,
      quoteAt: (s) => (s > 10 ? null : { impactPct: s * 0.1, costPct: 0.3 }), // book dies > $10
    });
    expect(d.action).toBe("EXECUTE_PARTIAL");
    expect(d.sizeUsd).toBe(10);
  });

  it("never recommends dust: the band floor is the minimum size", () => {
    const d = chooseRebalanceSize({
      gapUsd: 100,
      minUsd: 3,
      maxUsd: 100,
      budgetPct: 0.2,
      quoteAt: (s) => ({ impactPct: s * 0.05, costPct: 0.3 }),
    });
    expect(d.sizeUsd).toBeGreaterThanOrEqual(3);
  });
});

describe("candidateSizesUsd", () => {
  it("probes absolute anchors + the fractional ladder, band-clamped", () => {
    const sizes = candidateSizesUsd(1, 20);
    expect(sizes[0]).toBe(1);
    expect(sizes[sizes.length - 1]).toBe(20);
    expect(sizes).toContain(2);
    expect(sizes).toContain(5);
    expect(new Set(sizes).size).toBe(sizes.length);
  });

  it("always includes both band edges", () => {
    const sizes = candidateSizesUsd(0.5, 7.3);
    expect(sizes).toContain(0.5);
    expect(sizes).toContain(7.3);
  });
});

describe("rebalanceImpactBudgetPct", () => {
  it("scales the budget by urgency and never exceeds the hard cap", () => {
    expect(rebalanceImpactBudgetPct(0.03, 4).budgetPct).toBe(0.5);
    expect(rebalanceImpactBudgetPct(0.1, 4).budgetPct).toBe(1.0);
    expect(rebalanceImpactBudgetPct(0.2, 4).budgetPct).toBe(1.5);
    expect(rebalanceImpactBudgetPct(0.5, 4).budgetPct).toBe(2.0);
    expect(rebalanceImpactBudgetPct(0.5, 4).urgency).toBe("emergency");
    // Hard cap wins when it's lower than the scaled budget.
    expect(rebalanceImpactBudgetPct(0.5, 1.2).budgetPct).toBe(1.2);
  });
});
