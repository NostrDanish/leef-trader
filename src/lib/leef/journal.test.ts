import { describe, expect, it } from "vitest";
import {
  aggregateEntries,
  reasonSignature,
  toNdjson,
  type JournalEntry,
} from "./journal";

const e = (over: Partial<JournalEntry>): JournalEntry => ({
  ts: 1_000,
  kind: "decision",
  ...over,
});

describe("reasonSignature", () => {
  it("groups reasons that differ only in numbers", () => {
    const a = reasonSignature("exact net edge -0.42% < required 0.30% — venue quote killed the thesis");
    const b = reasonSignature("exact net edge -1.07% < required 0.30% — venue quote killed the thesis");
    expect(a).toBe(b);
    expect(a).toContain("#");
  });

  it("collapses long hex (txids) to a stable marker", () => {
    const sig = reasonSignature("tx 4f2a9c1e8b7d6f5a4f2a9c1e8b7d6f5a failed");
    expect(sig).toContain("0x…");
    expect(sig).not.toContain("4f2a");
  });

  it("caps length", () => {
    expect(reasonSignature("x".repeat(500)).length).toBeLessThanOrEqual(90);
  });
});

describe("aggregateEntries", () => {
  it("returns an empty evidence set for no entries", () => {
    const s = aggregateEntries([]);
    expect(s.entries).toBe(0);
    expect(s.byStrategy).toEqual([]);
    expect(s.oldestTs).toBeNull();
    expect(s.topGateFails).toEqual([]);
  });

  it("aggregates decisions, gates, executions and calibration per strategy", () => {
    const entries: JournalEntry[] = [
      e({ ts: 100, kind: "decision", strategy: "auto", decision: "hold", reason: "no edge" }),
      e({ ts: 200, kind: "decision", strategy: "auto", decision: "hold", reason: "no edge" }),
      e({ ts: 300, kind: "gate", strategy: "auto", gate: "entry", pass: false, reason: "exact net edge -0.4% < required 0.3%" }),
      e({ ts: 400, kind: "gate", strategy: "auto", gate: "entry", pass: false, reason: "exact net edge -1.1% < required 0.3%" }),
      e({ ts: 500, kind: "gate", strategy: "auto", gate: "entry", pass: true, expectedOut: 120 }),
      e({ ts: 600, kind: "execution", strategy: "auto", action: "buy", status: "paper", pnlUsd: 0 }),
      e({ ts: 700, kind: "execution", strategy: "auto", action: "sell", status: "confirmed", pnlUsd: 0.42, txid: "abc" }),
      e({ ts: 800, kind: "calibration", strategy: "auto", predEdgePct: 0.8, realEdgePct: 0.55, pnlUsd: 0.42 }),
      e({ ts: 900, kind: "decision", strategy: "growth", decision: "error", reason: "RPC timeout" }),
    ];
    const s = aggregateEntries(entries);
    expect(s.entries).toBe(9);
    expect(s.oldestTs).toBe(100);
    expect(s.newestTs).toBe(900);

    const auto = s.byStrategy.find((x) => x.strategy === "auto")!;
    expect(auto.decisions).toBe(2);
    expect(auto.holds).toBe(2);
    expect(auto.gatePass).toBe(1);
    expect(auto.gateFail).toBe(2);
    expect(auto.executions).toBe(2);
    expect(auto.paper).toBe(1);
    expect(auto.confirmed).toBe(1);
    expect(auto.wins).toBe(1);
    expect(auto.pnlUsd).toBeCloseTo(0.42);
    expect(auto.predN).toBe(1);
    expect(auto.predEdgePctSum).toBeCloseTo(0.8);
    expect(auto.realEdgePctSum).toBeCloseTo(0.55);

    const growth = s.byStrategy.find((x) => x.strategy === "growth")!;
    expect(growth.errors).toBe(1);

    // The two numeric gate fails collapse into ONE signature.
    expect(s.topGateFails).toHaveLength(1);
    expect(s.topGateFails[0]!.count).toBe(2);
    expect(s.topGateFails[0]!.reason).toContain("#");
  });

  it("buckets entries without a strategy under a placeholder", () => {
    const s = aggregateEntries([e({ kind: "decision", decision: "hold" })]);
    expect(s.byStrategy[0]!.strategy).toBe("—");
  });

  it("aggregates gateDrift and venue impact from gate entries", () => {
    const s = aggregateEntries([
      e({ kind: "gate", gate: "entry", pass: true, modelOut: 100, expectedOut: 102, venueImpactPct: 0.4 }),
      e({ kind: "gate", gate: "entry", pass: true, modelOut: 100, expectedOut: 98, venueImpactPct: -0.2 }),
      e({ kind: "gate", gate: "entry", pass: false, reason: "veto" }), // no drift data
    ]);
    expect(s.gateDrift.n).toBe(2);
    expect(s.gateDrift.meanPct).toBeCloseTo(0); // +2% and −2% cancel
    expect(s.gateDrift.meanAbsPct).toBeCloseTo(2);
    expect(s.venueImpact.n).toBe(2);
    expect(s.venueImpact.meanPct).toBeCloseTo(0.1);
    expect(s.venueImpact.meanAbsPct).toBeCloseTo(0.3);
  });

  it("reports zero venue impact when no gate entry carries it", () => {
    const s = aggregateEntries([e({ kind: "gate", gate: "swap", pass: true, modelOut: 5, expectedOut: 5 })]);
    expect(s.gateDrift.n).toBe(1);
    expect(s.venueImpact).toEqual({ n: 0, meanPct: 0, meanAbsPct: 0 });
  });
});

describe("toNdjson", () => {
  it("serializes one JSON object per line with a trailing newline", () => {
    const out = toNdjson([
      e({ ts: 1, kind: "decision", decision: "hold" }),
      e({ ts: 2, kind: "gate", gate: "swap", pass: true }),
    ]);
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).ts).toBe(1);
    expect(JSON.parse(lines[1]!).gate).toBe("swap");
  });

  it("is empty for no entries", () => {
    expect(toNdjson([])).toBe("");
  });
});
