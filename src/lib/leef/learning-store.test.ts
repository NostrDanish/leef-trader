/**
 * Counterfactual engine integration: a veto registered, then judged — and
 * the REAL trade tape (someone else's fills in the window) outranks the
 * price-mark model when it exists.
 */
import { describe, expect, it } from "vitest";
import { onJournalEntry, type JournalEntry } from "./journal";
import {
  evaluateDueCounterfactuals,
  pendingCounterfactualCount,
  registerCounterfactual,
  CF_HORIZON_MS,
} from "./learning-store";
import type { LeefSnapshot } from "./types";

function mkSnap(priceWax: number, tapePool217: number[], now: number): LeefSnapshot {
  return {
    source: "live",
    fetchedAt: new Date(now).toISOString(),
    waxUsd: 0.02,
    leefUsd: priceWax * 0.02,
    waxPerLeef: priceWax,
    pools: [],
    aux: [],
    trades: tapePool217.map((p, i) => ({
      poolId: 217,
      pair: "LEEF / WAX",
      time: new Date(now - i * 1_000).toISOString(),
      timestamp: now - i * 1_000,
      type: "buy" as const,
      priceWax: p,
      amountLeef: 1000,
      amountPair: 1,
      pairSymbol: "WAX",
      txHash: `t${i}`,
      usdVolume: 0.02,
      account: "someone",
    })),
    universe: [
      {
        symbol: "LEEF",
        contract: "leefmaincorp",
        decimals: 4,
        alcorId: "leef-leefmaincorp",
        poolId: 217,
        waxPerToken: priceWax,
        usdPrice: priceWax * 0.02,
        tvlUsd: 1000,
        stable: false,
      },
    ],
  };
}

describe("counterfactual evaluation", () => {
  it("judges a veto with the real tape when fills printed in the window", () => {
    const seen: JournalEntry[] = [];
    const off = onJournalEntry((e) => seen.push(e));
    try {
      const t0 = Date.now();
      // Veto registered: LEEF mark 1e-5, costs 1%.
      registerCounterfactual({
        cfKind: "entry",
        horizonMs: 1, // due immediately at evaluation time
        strategy: "auto",
        tokenIn: "WAX",
        tokenOut: "LEEF",
        amountIn: 10,
        sizeUsd: 0.2,
        poolIds: [217],
        venues: ["alcor"],
        predNetPct: 0.4,
        costsPct: 1,
        entryMarkUsd: 0.00001,
        holdReasonClass: "EXACT_GATE_ENTRY",
      });
      expect(pendingCounterfactualCount()).toBe(1);
      // The tape: real fills at 0.00055 WAX/LEEF after the veto → +10%.
      const snap = mkSnap(0.00055, [0.00055, 0.00054], t0 + 10);
      const judged = evaluateDueCounterfactuals(snap, t0 + 10);
      expect(judged).toBe(1);
      const cf = seen.find((e) => e.kind === "counterfactual");
      expect(cf).toBeDefined();
      expect(cf!.cfModel).toBe("tape");
      expect(cf!.cfLabel).toBe("FALSE_HOLD"); // +10% tape − 1% costs ≈ +9%
      expect(cf!.cfPct).toBeGreaterThan(5);
      // Dual horizon: the same veto re-registered for the 30-minute read.
      expect(pendingCounterfactualCount()).toBe(1);
    } finally {
      off();
    }
  });

  it("falls back to the mark model when no fills printed", () => {
    const seen: JournalEntry[] = [];
    const off = onJournalEntry((e) => seen.push(e));
    try {
      const t0 = Date.now();
      registerCounterfactual({
        cfKind: "entry",
        horizonMs: 1,
        strategy: "auto",
        tokenIn: "WAX",
        tokenOut: "LEEF",
        amountIn: 10,
        sizeUsd: 0.2,
        poolIds: [217],
        venues: ["alcor"],
        predNetPct: 0.4,
        costsPct: 1,
        entryMarkUsd: 0.00001,
        holdReasonClass: "GOVERNOR",
      });
      // No trades in the window → mark model: mark fell 20% → TRUE_HOLD.
      const snap = mkSnap(0.0004, [], t0 + 10);
      const judged = evaluateDueCounterfactuals(snap, t0 + 10);
      expect(judged).toBe(1);
      const cf = seen.find((e) => e.kind === "counterfactual");
      expect(cf!.cfModel).toBe("mark");
      expect(cf!.cfLabel).toBe("TRUE_HOLD");
    } finally {
      off();
    }
  });

  it("nothing is due before the horizon", () => {
    expect(
      evaluateDueCounterfactuals(mkSnap(0.0005, [], Date.now()), Date.now() + CF_HORIZON_MS - 60_000),
    ).toBe(0);
  });
});
