import { describe, expect, it } from "vitest";
import {
  AI_EXEC_CONFIDENCE_MIN,
  AI_QID,
  buildAiQuestions,
  parseAiProposal,
  type AiSnapshotSummary,
} from "./ai-executor";
import type { JevAnswers } from "./jev-client";

function summary(): AiSnapshotSummary {
  return {
    waxUsd: 0.0047,
    leefUsd: 1.7e-7,
    waxPerLeef: 3.6e-5,
    fetchedAt: "2026-10-20T00:00:00.000Z",
    base: "LEEF",
    quote: "WAX",
    strategy: "auto",
    balances: { WAX: 120, LEEF: 5_000_000 },
    positionUsd: 0.85,
    positionAmount: 5_000_000,
    topPools: [
      { id: 217, pair: "LEEF/WAX", feePct: 0.3, tvlUsd: 900, volume24Usd: 6.6, change24: 1.2 },
    ],
    candidatesIn: ["WAX", "LEEF"],
    candidatesOut: ["LEEF", "WAX", "WAXUSDC"],
  };
}

function answers(over: Partial<JevAnswers> = {}): JevAnswers {
  return {
    [AI_QID.action]: { type: "choice", choice: "buy", confidence: 0.9 },
    [AI_QID.sizeBucket]: { type: "choice", choice: "half", confidence: 0.8 },
    [AI_QID.swapTokenIn]: { type: "choice", choice: "WAX", confidence: 0.7 },
    [AI_QID.swapTokenOut]: { type: "choice", choice: "LEEF", confidence: 0.7 },
    [AI_QID.riskStress]: { type: "noul", noul: 0.1 },
    [AI_QID.riskExecute]: { type: "noul", noul: 0.9 },
    ...over,
  };
}

describe("buildAiQuestions", () => {
  it("asks one action choice plus per-arg closed sets and risk nouls in a single request", () => {
    const q = buildAiQuestions(summary());
    expect(q[AI_QID.action]?.type).toBe("choice");
    const criteria = (q[AI_QID.action] as { criteria: Record<string, unknown> }).criteria;
    expect(Object.keys(criteria)).toEqual(
      expect.arrayContaining(["hold", "buy", "sell", "swap", "rebalance", "reduce_risk", "cancel_all"]),
    );
    expect(q[AI_QID.sizeBucket]?.type).toBe("choice");
    expect(q[AI_QID.swapTokenIn]?.type).toBe("choice");
    expect(q[AI_QID.riskStress]?.type).toBe("noul");
    expect(q[AI_QID.riskExecute]?.type).toBe("noul");
    // Closed sets come from the summary, never free text.
    const tin = (q[AI_QID.swapTokenIn] as { criteria: Record<string, unknown> }).criteria;
    expect(Object.keys(tin)).toEqual(["WAX", "LEEF"]);
  });
});

describe("parseAiProposal", () => {
  it("parses a buy proposal; confidence is the weakest relevant judgment", () => {
    const p = parseAiProposal(answers());
    expect(p).not.toBeNull();
    expect(p!.action).toBe("buy");
    expect(p!.params.sizePct).toBe("50");
    // Weakest = size bucket at 0.8 (risk nouls: |0.9-0.5|*2 = 0.8 tie broken first-seen).
    expect(p!.confidence).toBeLessThanOrEqual(0.8);
    expect(p!.confidence).toBeGreaterThanOrEqual(AI_EXEC_CONFIDENCE_MIN - 0.2);
    expect(p!.rationale).toContain("action=buy");
  });

  it("hold needs no size bucket and ignores swap args", () => {
    const a = answers();
    delete a[AI_QID.sizeBucket];
    const p = parseAiProposal({
      ...a,
      [AI_QID.action]: { type: "choice", choice: "hold", confidence: 0.6 },
    });
    expect(p).not.toBeNull();
    expect(p!.action).toBe("hold");
    expect(p!.params.sizePct).toBeUndefined();
  });

  it("returns null on missing/malformed action answers", () => {
    expect(parseAiProposal({})).toBeNull();
    expect(parseAiProposal({ [AI_QID.action]: { type: "choice", choice: "yolo", confidence: 0.99 } } as JevAnswers)).toBeNull();
    expect(parseAiProposal({ ...answers(), [AI_QID.action]: { type: "choice", choice: "buy" } } as unknown as JevAnswers)).toBeNull();
  });

  it("never acts on unsafe data (risk_execute < 0.5 vetoes everything but hold)", () => {
    const p = parseAiProposal({ ...answers(), [AI_QID.riskExecute]: { type: "noul", noul: 0.2 } });
    expect(p).toBeNull();
  });

  it("acute stress vetoes entries but not exits", () => {
    const stressed = { ...answers(), [AI_QID.riskStress]: { type: "noul", noul: 0.9 } };
    expect(parseAiProposal(stressed)).toBeNull(); // buy vetoed
    const exit = parseAiProposal({
      ...stressed,
      [AI_QID.action]: { type: "choice", choice: "reduce_risk", confidence: 0.95 },
    });
    expect(exit).not.toBeNull();
    expect(exit!.action).toBe("reduce_risk");
  });

  it("swap requires both token args, distinct, with confidences", () => {
    const p = parseAiProposal({
      ...answers(),
      [AI_QID.action]: { type: "choice", choice: "swap", confidence: 0.9 },
    });
    expect(p).not.toBeNull();
    expect(p!.params.tokenIn).toBe("WAX");
    expect(p!.params.tokenOut).toBe("LEEF");
    // weakest includes the 0.7 token confidences
    expect(p!.confidence).toBeCloseTo(0.7, 6);
    expect(p!.weakest).toBe(AI_QID.swapTokenIn);

    const same = parseAiProposal({
      ...answers(),
      [AI_QID.action]: { type: "choice", choice: "swap", confidence: 0.9 },
      [AI_QID.swapTokenOut]: { type: "choice", choice: "WAX", confidence: 0.9 },
    });
    expect(same).toBeNull();
  });

  it("unknown size bucket is unusable", () => {
    const p = parseAiProposal({
      ...answers(),
      [AI_QID.sizeBucket]: { type: "choice", choice: "yuge", confidence: 0.99 },
    });
    expect(p).toBeNull();
  });

  it("exposes the documented execution gate constant", () => {
    expect(AI_EXEC_CONFIDENCE_MIN).toBe(0.75);
  });
});
