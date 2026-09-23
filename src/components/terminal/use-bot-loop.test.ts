/**
 * HOLD-reason surfacing dedupe: gate decisions still happen every cycle, but
 * an identical HOLD reason (volume gate, stale-price governor, …) is surfaced
 * to the decision log at most once per 5 minutes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resetHoldDedupe, shouldSurfaceHold, HOLD_REASON_DEDUPE_MS } from "./use-bot-loop";

const T0 = Date.parse("2026-09-19T12:00:00Z");
const GATED =
  "Volume gated: pool #217: no third-party swap observed this session — volume gate fails closed";

describe("HOLD-reason surfacing dedupe", () => {
  beforeEach(() => resetHoldDedupe());

  it("surfaces an identical reason once per 5 min", () => {
    expect(shouldSurfaceHold(GATED, T0)).toBe(true);
    // Every cycle for the next 5 minutes: still blocked, but NOT re-surfaced.
    expect(shouldSurfaceHold(GATED, T0 + 15_000)).toBe(false);
    expect(shouldSurfaceHold(GATED, T0 + HOLD_REASON_DEDUPE_MS - 1)).toBe(false);
    expect(shouldSurfaceHold(GATED, T0 + HOLD_REASON_DEDUPE_MS)).toBe(true);
  });

  it("dedupes per reason string — a different reason surfaces immediately", () => {
    expect(shouldSurfaceHold(GATED, T0)).toBe(true);
    const other =
      "Volume-X: pool #1159: last third-party swap 12.0 min ago > 10 min gate — book is dead, not printing tape";
    expect(shouldSurfaceHold(other, T0 + 1_000)).toBe(true);
    expect(shouldSurfaceHold(other, T0 + 2_000)).toBe(false);
  });

  it("governor stale-price holds dedupe the same way (the 30s spam class)", () => {
    const governor =
      "Portfolio governor: LEEF price uncertain: price is stale (last chain read 212s ago, limit 75s)";
    expect(shouldSurfaceHold(governor, T0)).toBe(true);
    expect(shouldSurfaceHold(governor, T0 + 30_000)).toBe(false);
    expect(shouldSurfaceHold(governor, T0 + HOLD_REASON_DEDUPE_MS)).toBe(true);
  });

  it("covers every reason shape volumeGateReason produces", () => {
    for (const r of [
      "Volume gated: pool #217: no third-party swap observed this session — volume gate fails closed",
      "Volume-X: no swap-flow data — volume intents fail closed (need evidence of third-party activity)",
      "Volume gated: pool #217: last third-party swap 12.0 min ago > 10 min gate — book is dead, not printing tape",
      "Volume-X: session echo budget spent ($5.01 ≥ $5.00 cap) — volume intents off until session reset",
    ]) {
      expect(shouldSurfaceHold(r, T0)).toBe(true);
      expect(shouldSurfaceHold(r, T0 + 1_000)).toBe(false);
    }
  });
});
