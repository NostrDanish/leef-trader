/**
 * Learning-core tests — Phase 2 audit evidence. Deterministic, no IDB.
 */
import { describe, expect, it } from "vitest";
import {
  applyEntry,
  bucketMeanEdge,
  confidenceFromSamples,
  counterfactualFromMark,
  counterfactualFromNetPct,
  DEFAULT_LEARNING_CONFIG,
  governArtifact,
  labelCounterfactual,
  learnedSizeMultiplier,
  learnedSlippagePct,
  proposeArtifacts,
  rebuildProfiles,
  rollbackArtifact,
  sizeBucketIndex,
  SIZE_BUCKET_LABELS,
  type LearningArtifact,
  type LearningProfiles,
  type PendingCounterfactual,
} from "./learning";
import type { JournalEntry } from "./journal";

const CFG = DEFAULT_LEARNING_CONFIG;
const T0 = 1_800_000_000_000;

function execEntry(over: Partial<JournalEntry>): JournalEntry {
  return {
    ts: T0,
    kind: "execution",
    action: "buy",
    status: "confirmed",
    poolIds: [217],
    venues: ["alcor"],
    routeSig: "direct:217",
    sizeUsd: 0.6,
    expectedOut: 100,
    actualOut: 99.5,
    ...over,
  };
}

function fillProfiles(n: number, over: Partial<JournalEntry> = {}): LearningProfiles {
  const p: LearningProfiles = {};
  for (let i = 0; i < n; i++) {
    applyEntry(p, execEntry({ ts: T0 + i * 60_000, ...over }), CFG);
  }
  return p;
}

describe("size buckets", () => {
  it("buckets edge cases land correctly", () => {
    expect(sizeBucketIndex(0.1)).toBe(0);
    expect(sizeBucketIndex(0.24)).toBe(0);
    expect(sizeBucketIndex(0.25)).toBe(1);
    expect(sizeBucketIndex(0.99)).toBe(2);
    expect(sizeBucketIndex(1)).toBe(3);
    expect(sizeBucketIndex(4.99)).toBe(4);
    expect(sizeBucketIndex(5)).toBe(5);
    expect(sizeBucketIndex(25)).toBe(7);
    expect(sizeBucketIndex(500)).toBe(7);
    expect(SIZE_BUCKET_LABELS).toHaveLength(8);
  });
});

describe("profiles", () => {
  it("accumulates confirmed executions into the right bucket", () => {
    const p = fillProfiles(3);
    const prof = p["pool:alcor:217"]!;
    expect(prof.executions).toBe(3);
    expect(prof.buckets[2]!.samples).toBe(3); // $0.60 → bucket 2
    expect(prof.buckets[2]!.confirmed).toBe(3);
    expect(prof.buckets[2]!.slipPctSum).toBeCloseTo(1.5, 6); // 0.5% each
    expect(prof.ewmaSlipPct).toBeCloseTo(0.5, 6);
  });

  it("infrastructure failures never touch market statistics", () => {
    const p: LearningProfiles = {};
    applyEntry(p, execEntry({ status: undefined, expectedOut: undefined, actualOut: undefined, failureClass: "RPC_FAILURE" }), CFG);
    applyEntry(p, execEntry({ status: undefined, expectedOut: undefined, actualOut: undefined, failureClass: "MIN_OUT_FAILED" }), CFG);
    const b = p["pool:alcor:217"]!.buckets[2]!;
    expect(b.infraFails).toBe(1);
    expect(b.econFails).toBe(1);
    expect(b.confirmed).toBe(0);
    expect(b.slipPctSum).toBe(0);
  });

  it("builds route profiles alongside pool profiles", () => {
    const p = fillProfiles(2);
    expect(p["route:direct:217"]).toBeDefined();
    expect(p["route:direct:217"]!.executions).toBe(2);
  });

  it("EWMA decays old evidence toward new", () => {
    const p: LearningProfiles = {};
    applyEntry(p, execEntry({ ts: T0, actualOut: 99 }), CFG); // 1% slip
    const before = p["pool:alcor:217"]!.ewmaSlipPct!;
    applyEntry(p, execEntry({ ts: T0 + CFG.halfLifeMs, actualOut: 97 }), CFG); // 3% slip one half-life later
    const after = p["pool:alcor:217"]!.ewmaSlipPct!;
    expect(before).toBeCloseTo(1, 6);
    expect(after).toBeCloseTo(2, 6); // 50/50 blend at exactly one half-life
  });
});

describe("learned slippage", () => {
  it("returns null below the sample floor", () => {
    const p = fillProfiles(CFG.minSamplesSlippage - 1);
    expect(learnedSlippagePct(p["pool:alcor:217"]!, 0.6, T0 + 86_400_000, CFG)).toBeNull();
  });

  it("returns a clamped estimate at the floor", () => {
    const p = fillProfiles(CFG.minSamplesSlippage);
    const v = learnedSlippagePct(p["pool:alcor:217"]!, 0.6, T0 + 86_400_000, CFG);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThanOrEqual(CFG.slipClampMinPct);
    expect(v!).toBeLessThanOrEqual(CFG.slipClampMaxPct);
    expect(v!).toBeCloseTo(0.5, 3);
  });

  it("clamps extreme learned slippage and ignores stale profiles", () => {
    const p = fillProfiles(CFG.minSamplesSlippage, { actualOut: 50 }); // 50% slip
    const v = learnedSlippagePct(p["pool:alcor:217"]!, 0.6, T0 + 86_400_000, CFG);
    expect(v!).toBe(CFG.slipClampMaxPct);
    expect(
      learnedSlippagePct(p["pool:alcor:217"]!, 0.6, T0 + CFG.staleAfterMs + 86_400_000, CFG),
    ).toBeNull();
  });
});

describe("learned size multiplier", () => {
  it("is 1 without evidence and never above 1", () => {
    expect(learnedSizeMultiplier(null, 5, T0, CFG)).toBe(1);
    const p = fillProfiles(CFG.minSamplesSizeCurve, { sizeUsd: 0.6, predEdgePct: 1, realizedEdgePct: 0.5 });
    const m = learnedSizeMultiplier(p["pool:alcor:217"]!, 0.6, T0 + 86_400_000, CFG);
    expect(m).toBe(1); // bucket 2 is healthy
    expect(m).toBeLessThanOrEqual(1);
  });

  it("shrinks the ceiling when the candidate's own bucket is destructive", () => {
    const p: LearningProfiles = {};
    // Healthy small buckets (8 samples → total crosses the 12 floor with the destructive ones).
    for (let i = 0; i < 8; i++) {
      applyEntry(p, execEntry({ ts: T0 + i * 60_000, sizeUsd: 1.5, predEdgePct: 1, realizedEdgePct: 0.4 }), CFG);
    }
    // Destructive $5–10 bucket.
    for (let i = 0; i < 4; i++) {
      applyEntry(p, execEntry({ ts: T0 + (10 + i) * 60_000, sizeUsd: 6, predEdgePct: 1, realizedEdgePct: -1 }), CFG);
    }
    const prof = p["pool:alcor:217"]!;
    const m = learnedSizeMultiplier(prof, 6, T0 + 86_400_000, CFG);
    expect(m).toBeLessThan(1);
    expect(m).toBeGreaterThanOrEqual(CFG.sizeMultMin);
    // A candidate BELOW the destructive bucket is untouched.
    expect(learnedSizeMultiplier(prof, 1.5, T0 + 86_400_000, CFG)).toBe(1);
  });
});

describe("counterfactual labeling", () => {
  const cf: PendingCounterfactual = {
    id: "x",
    registeredAt: T0,
    horizonMs: 300_000,
    cfKind: "entry",
    strategy: "auto",
    tokenIn: "WAX",
    tokenOut: "LEEF",
    amountIn: 10,
    sizeUsd: 0.2,
    poolIds: [217],
    venues: ["alcor"],
    predNetPct: 0.5,
    costsPct: 1,
    entryMarkUsd: 0.1,
    holdReasonClass: "EXACT_GATE_ENTRY",
  };

  it("labels TRUE_HOLD / FALSE_HOLD / NEUTRAL by the noise band", () => {
    expect(labelCounterfactual(0.2)).toBe("FALSE_HOLD");
    expect(labelCounterfactual(-0.2)).toBe("TRUE_HOLD");
    expect(labelCounterfactual(0.05)).toBe("NEUTRAL_HOLD");
  });

  it("mark model: thesis realized minus modeled costs", () => {
    // Mark rose 2%; costs were 1% → counterfactual ≈+1% → FALSE_HOLD.
    const good = counterfactualFromMark(cf, 0.102)!;
    expect(good.cfPct).toBeCloseTo(1, 6);
    expect(good.label).toBe("FALSE_HOLD");
    // Mark fell 5% → −6% → TRUE_HOLD.
    const bad = counterfactualFromMark(cf, 0.095)!;
    expect(bad.label).toBe("TRUE_HOLD");
    expect(bad.cfPct).toBeCloseTo(-6, 6);
    // No valid marks → no label (never fabricated).
    expect(counterfactualFromMark(cf, 0)).toBeNull();
  });

  it("requote model labels by current net pct", () => {
    expect(counterfactualFromNetPct(0.4).label).toBe("FALSE_HOLD");
    expect(counterfactualFromNetPct(-0.4).label).toBe("TRUE_HOLD");
  });
});

describe("learning governor", () => {
  const base: LearningArtifact = {
    id: "POOL_SLIPPAGE_PROFILE:pool:alcor:217",
    type: "POOL_SLIPPAGE_PROFILE",
    scopeKey: "pool:alcor:217",
    value: 0.2,
    previousValue: 0.05,
    maxAllowedChange: 0.75,
    samples: 10,
    confidence: 0.6,
    createdAt: T0,
    expiresAt: T0 + CFG.artifactTtlMs,
    status: "shadow",
    shadow: { n: 0, baselineErrSum: 0, learnedErrSum: 0 },
  };

  it("rejects schema violations", () => {
    expect(governArtifact({ ...base, id: "wrong" }, T0, CFG).action).toBe("reject");
    expect(governArtifact({ ...base, value: NaN }, T0, CFG).action).toBe("reject");
  });

  it("rejects clamp violations", () => {
    const over: LearningArtifact = { ...base, value: 99 };
    expect(governArtifact(over, T0, CFG).action).toBe("reject");
    const sizeBad: LearningArtifact = {
      ...base,
      id: "POOL_SIZE_MULTIPLIER:pool:alcor:217",
      type: "POOL_SIZE_MULTIPLIER",
      value: 0.2, // below sizeMultMin — can never shrink this hard
      previousValue: 1,
      maxAllowedChange: 0.5,
    };
    expect(governArtifact(sizeBad, T0, CFG).action).toBe("reject");
  });

  it("rejects insufficient evidence", () => {
    expect(governArtifact({ ...base, samples: 2 }, T0, CFG).action).toBe("reject");
    expect(governArtifact({ ...base, confidence: 0 }, T0, CFG).action).toBe("reject");
  });

  it("keeps shadowing until enough shadow samples, then promotes only when learned beats baseline", () => {
    expect(governArtifact(base, T0, CFG).action).toBe("keep");
    const proven: LearningArtifact = {
      ...base,
      shadow: { n: CFG.shadowMinSamples, baselineErrSum: 6, learnedErrSum: 3 }, // 1.0 vs 0.5
    };
    expect(governArtifact(proven, T0, CFG).action).toBe("promote");
    const worse: LearningArtifact = {
      ...base,
      shadow: { n: CFG.shadowMinSamples, baselineErrSum: 6, learnedErrSum: 7.2 }, // 1.0 vs 1.2
    };
    expect(governArtifact(worse, T0, CFG).action).toBe("rollback");
  });

  it("rolls back an active artifact that regresses", () => {
    const active: LearningArtifact = {
      ...base,
      status: "active",
      shadow: { n: CFG.shadowMinSamples, baselineErrSum: 6, learnedErrSum: 7.2 },
    };
    expect(governArtifact(active, T0, CFG).action).toBe("rollback");
    const healthy: LearningArtifact = {
      ...base,
      status: "active",
      shadow: { n: CFG.shadowMinSamples, baselineErrSum: 6, learnedErrSum: 3 },
    };
    expect(governArtifact(healthy, T0, CFG).action).toBe("keep");
  });

  it("size artifacts promote only when the watched bucket stays destructive on fresh evidence", () => {
    const sizeArt: LearningArtifact = {
      id: "POOL_SIZE_MULTIPLIER:pool:alcor:217",
      type: "POOL_SIZE_MULTIPLIER",
      scopeKey: "pool:alcor:217",
      value: 0.6,
      previousValue: 1,
      maxAllowedChange: 0.5,
      samples: 14,
      confidence: 0.5,
      createdAt: T0,
      expiresAt: T0 + CFG.artifactTtlMs,
      status: "shadow",
      shadow: { n: 0, baselineErrSum: 0, learnedErrSum: 0 },
      watchBucket: 5,
    };
    expect(governArtifact(sizeArt, T0, CFG).action).toBe("keep"); // no fresh evidence yet
    const stillBad: LearningArtifact = {
      ...sizeArt,
      shadow: { n: CFG.shadowMinSamples, baselineErrSum: -6, learnedErrSum: 0 }, // mean −1%
    };
    expect(governArtifact(stillBad, T0, CFG).action).toBe("promote");
    const recovered: LearningArtifact = {
      ...sizeArt,
      shadow: { n: CFG.shadowMinSamples, baselineErrSum: 3, learnedErrSum: 0 }, // mean +0.5%
    };
    expect(governArtifact(recovered, T0, CFG).action).toBe("rollback"); // proposal void
    const activeRecovered: LearningArtifact = { ...recovered, status: "active" };
    expect(governArtifact(activeRecovered, T0, CFG).action).toBe("rollback"); // revert ceiling
  });

  it("expires stale artifacts and rolls back to the deterministic default", () => {
    expect(governArtifact(base, T0 + CFG.artifactTtlMs + 1, CFG).action).toBe("expire");
    const rolled = rollbackArtifact({ ...base, status: "active", value: 0.4 });
    expect(rolled.status).toBe("rolled_back");
    expect(rolled.value).toBe(base.previousValue);
  });
});

describe("artifact proposals from profiles", () => {
  it("proposes a slippage artifact once evidence crosses the floor", () => {
    const p = fillProfiles(CFG.minSamplesSlippage);
    const arts = proposeArtifacts(p["pool:alcor:217"]!, T0 + 86_400_000, CFG, { slippagePct: 0.05 });
    const slip = arts.find((a) => a.type === "POOL_SLIPPAGE_PROFILE");
    expect(slip).toBeDefined();
    expect(slip!.status).toBe("shadow");
    expect(slip!.value).toBeCloseTo(0.5, 3);
    expect(slip!.previousValue).toBe(0.05);
    expect(slip!.confidence).toBeCloseTo(confidenceFromSamples(CFG.minSamplesSlippage, CFG.minSamplesSlippage), 6);
  });

  it("proposes nothing for stale profiles or thin evidence", () => {
    const thin = fillProfiles(2);
    expect(proposeArtifacts(thin["pool:alcor:217"]!, T0 + 60_000, CFG, { slippagePct: 0.05 })).toHaveLength(0);
    const stale = fillProfiles(CFG.minSamplesSlippage);
    expect(
      proposeArtifacts(stale["pool:alcor:217"]!, T0 + CFG.staleAfterMs + 86_400_000, CFG, { slippagePct: 0.05 }),
    ).toHaveLength(0);
  });

  it("rebuilds profiles from a journal scan", () => {
    const entries: JournalEntry[] = [
      execEntry({ ts: T0 }),
      execEntry({ ts: T0 + 60_000, actualOut: 99 }),
      { ts: T0 + 2, kind: "decision", decision: "hold", reason: "no edge" },
      { ts: T0 + 3, kind: "gate", gate: "swap", pass: false, poolIds: [217], venues: ["alcor"] },
    ];
    const p = rebuildProfiles(entries, CFG);
    expect(p["pool:alcor:217"]!.executions).toBe(2);
    expect(p["pool:alcor:217"]!.gateFails).toBe(1);
    expect(bucketMeanEdge(p["pool:alcor:217"]!.buckets[2]!)).toBeNull(); // no edge data on these
  });
});
