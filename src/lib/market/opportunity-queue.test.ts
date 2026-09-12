import { describe, expect, it } from "vitest";
import { rankOpportunities, selectOpportunity, type TradeOpportunity } from "./opportunity-queue";

function op(over: Partial<TradeOpportunity>): TradeOpportunity {
  return {
    id: "x",
    intent: "profit",
    source: "test",
    tokenIn: "WAX",
    tokenOut: "LEEF",
    amountIn: 10,
    notionalUsd: 10,
    expectedNetProfitUsd: 0.1,
    expectedNetEdgePct: 1,
    confidence: 0.9,
    liquidityUsd: 10_000,
    quoteAgeMs: 100,
    inventoryImprovementUsd: 0,
    expectedLossUsd: 0,
    status: "candidate",
    reason: "test",
    ...over,
  };
}

const budgets = {
  volumeLossRemainingUsd: 0.05,
  volumeRemainingUsd: 20,
  minProfitUsd: 0.001,
  maxQuoteAgeMs: 10_000,
};

describe("opportunity queue", () => {
  it("selects one profitable action before maintenance and volume", () => {
    const winner = selectOpportunity(
      [
        op({ id: "volume", intent: "volume", expectedNetProfitUsd: -0.01, expectedLossUsd: 0.01 }),
        op({ id: "rebalance", intent: "rebalance", expectedNetProfitUsd: -0.001, inventoryImprovementUsd: 5 }),
        op({ id: "profit", intent: "profit", expectedNetProfitUsd: 0.02 }),
      ],
      budgets,
    );
    expect(winner?.id).toBe("profit");
    expect(winner?.status).toBe("selected");
  });

  it("rejects stale candidates and over-budget volume", () => {
    const ranked = rankOpportunities(
      [
        op({ id: "stale", quoteAgeMs: 20_000 }),
        op({ id: "volume", intent: "volume", notionalUsd: 50, expectedLossUsd: 0.1 }),
      ],
      budgets,
    );
    expect(ranked.every((o) => o.status === "rejected")).toBe(true);
    expect(ranked.map((o) => o.reason)).toContain("STALE_DATA");
    expect(ranked.map((o) => o.reason)).toContain("VOLUME_BUDGET");
  });

  it("chooses larger net USD profit rather than headline edge percent", () => {
    const winner = selectOpportunity(
      [
        op({ id: "twenty-percent-dollar", amountIn: 1, expectedNetEdgePct: 20, expectedNetProfitUsd: 0.2 }),
        op({ id: "three-percent-hundred", amountIn: 100, expectedNetEdgePct: 3, expectedNetProfitUsd: 3 }),
      ],
      budgets,
    );
    expect(winner?.id).toBe("three-percent-hundred");
  });
});
