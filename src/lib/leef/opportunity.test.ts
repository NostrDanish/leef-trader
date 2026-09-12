import { describe, expect, it } from "vitest";
import {
  buildScoredOpportunity,
  calibrationHaircut,
  clearDeadOpportunities,
  executionProbability,
  isDeadOpportunity,
  markDeadOpportunity,
  rejectOpportunity,
  selectBestOpportunity,
  DEFAULT_OPPORTUNITY_GATE,
  type ScoredOpportunity,
} from "./opportunity";

function opp(over: Partial<ScoredOpportunity> & { fingerprint: string }): ScoredOpportunity {
  const hops = over.hops ?? 1;
  const impactPct = over.impactPct ?? 0.3;
  const liquidityUsd = over.liquidityUsd ?? 50_000;
  const exec = over.executionProbability ?? executionProbability({ hops, impactPct, tvlUsd: liquidityUsd });
  const net = over.expectedNetProfitUsd ?? 0.05;
  const ev =
    over.expectedValueUsd ??
    net * exec * (over.freshnessFactor ?? 1) * (over.inventoryFactor ?? 1) * (over.calibrationHaircut ?? 1);
  return {
    fingerprint: over.fingerprint,
    intent: over.intent ?? "profit",
    source: over.source ?? "test",
    tokenIn: over.tokenIn ?? "WAX",
    tokenOut: over.tokenOut ?? "LEEF",
    amountIn: over.amountIn ?? 10,
    notionalUsd: over.notionalUsd ?? 10,
    expectedNetProfitUsd: net,
    expectedNetEdgePct: over.expectedNetEdgePct ?? 1,
    hops,
    liquidityUsd,
    impactPct,
    executionProbability: exec,
    freshnessFactor: over.freshnessFactor ?? 1,
    inventoryFactor: over.inventoryFactor ?? 1,
    calibrationHaircut: over.calibrationHaircut ?? 1,
    strategyConfidence: over.strategyConfidence ?? 1,
    expectedValueUsd: ev,
    score: over.score ?? 50,
    explain: over.explain ?? [],
  };
}

describe("executionProbability", () => {
  it("penalizes hops and thin books", () => {
    const deepDirect = executionProbability({ hops: 1, impactPct: 0.2, tvlUsd: 80_000 });
    const thinHop = executionProbability({ hops: 3, impactPct: 2.5, tvlUsd: 400 });
    expect(deepDirect).toBeGreaterThan(thinHop);
    expect(deepDirect).toBeGreaterThan(0.8);
    expect(thinHop).toBeLessThan(0.6);
  });
});

describe("calibrationHaircut", () => {
  it("trusts uncalibrated strategies", () => {
    expect(calibrationHaircut(undefined)).toBe(1);
    expect(calibrationHaircut({ trades: 1, predEdgePctSum: 0.8, realEdgePctSum: 0.1 })).toBe(1);
  });
  it("haircuts repeated over-prediction", () => {
    const h = calibrationHaircut({ trades: 10, predEdgePctSum: 8, realEdgePctSum: 1 });
    expect(h).toBeCloseTo(0.3, 5); // 0.1/0.8 = 0.125, floored at 0.3
  });
});

describe("selectBestOpportunity", () => {
  it("prefers a smaller-percent deep 1-hop over a larger-percent thin 3-hop", () => {
    const thin = buildScoredOpportunity({
      fingerprint: "thin",
      intent: "profit",
      source: "spread",
      tokenIn: "WAX",
      tokenOut: "LEEF",
      amountIn: 100,
      notionalUsd: 100,
      expectedNetProfitUsd: 1.8,
      expectedNetEdgePct: 1.8,
      hops: 3,
      liquidityUsd: 400,
      impactPct: 2.4,
      quoteAgeMs: 1_000,
      maxQuoteAgeMs: 45_000,
      inventoryFactor: 1,
      calibrationHaircut: 1,
      strategyConfidence: 0.7,
    });
    const deep = buildScoredOpportunity({
      fingerprint: "deep",
      intent: "profit",
      source: "signal",
      tokenIn: "WAX",
      tokenOut: "LEEF",
      amountIn: 100,
      notionalUsd: 100,
      expectedNetProfitUsd: 0.9,
      expectedNetEdgePct: 0.9,
      hops: 1,
      liquidityUsd: 80_000,
      impactPct: 0.2,
      quoteAgeMs: 1_000,
      maxQuoteAgeMs: 45_000,
      inventoryFactor: 1,
      calibrationHaircut: 1,
      strategyConfidence: 0.99,
    });
    expect(deep.expectedValueUsd).toBeGreaterThan(thin.expectedValueUsd);
    const { winner } = selectBestOpportunity([thin, deep], DEFAULT_OPPORTUNITY_GATE);
    expect(winner?.fingerprint).toBe("deep");
  });

  it("does not force a losing trade to rebalance inventory", () => {
    const loser = opp({
      fingerprint: "loser",
      expectedNetProfitUsd: -0.05,
      expectedValueUsd: -0.04,
      inventoryFactor: 1.25,
    });
    const why = rejectOpportunity(loser, DEFAULT_OPPORTUNITY_GATE);
    expect(why).toBe("INSUFFICIENT_EDGE");
  });

  it("rejects volume that is too expensive relative to the LP-fee budget", () => {
    const pricey = opp({
      fingerprint: "vol",
      intent: "volume",
      expectedNetProfitUsd: -2,
      notionalUsd: 100,
      expectedValueUsd: -1,
    });
    expect(rejectOpportunity(pricey, DEFAULT_OPPORTUNITY_GATE)).toBe("VOLUME_TOO_EXPENSIVE");
  });

  it("allows a zero-loss-average volume echo (cost inside LP budget)", () => {
    const echo = opp({
      fingerprint: "echo",
      intent: "volume",
      expectedNetProfitUsd: -0.006,
      notionalUsd: 1,
      hops: 2,
      impactPct: 0.4,
      liquidityUsd: 5_000,
    });
    expect(rejectOpportunity(echo, DEFAULT_OPPORTUNITY_GATE)).toBeNull();
  });

  it("allows a dust-sized profit ($1e-10) instead of demanding a cent", () => {
    const dust = opp({
      fingerprint: "dust",
      intent: "profit",
      expectedNetProfitUsd: 1e-10,
      expectedNetEdgePct: 0.01,
      expectedValueUsd: 8e-11,
      hops: 1,
      impactPct: 0.3,
      liquidityUsd: 20_000,
    });
    expect(rejectOpportunity(dust, DEFAULT_OPPORTUNITY_GATE)).toBeNull();
  });

  it("returns null when every candidate is dead or rejected — doing nothing is valid", () => {
    clearDeadOpportunities();
    markDeadOpportunity("dead", 60_000, 1_000);
    expect(isDeadOpportunity("dead", 1_500)).toBe(true);
    const { winner } = selectBestOpportunity(
      [opp({ fingerprint: "dead", expectedNetProfitUsd: 1, expectedValueUsd: 1 })],
      DEFAULT_OPPORTUNITY_GATE,
      1_500,
    );
    expect(winner).toBeNull();
    clearDeadOpportunities();
  });
});
