import { describe, expect, it } from "vitest";
import { NEVER_FETCHED_AT, unavailableSnapshot } from "./fallback";

describe("unavailableSnapshot (honest no-data shape)", () => {
  it("carries empty collections and zero prices — never fabricated numbers", () => {
    const snap = unavailableSnapshot("test warning");
    expect(snap.source).toBe("unavailable");
    expect(snap.pools).toEqual([]);
    expect(snap.aux).toEqual([]);
    expect(snap.trades).toEqual([]);
    expect(snap.universe).toEqual([]);
    expect(snap.venues).toEqual([]);
    expect(snap.leefUsd).toBe(0);
    expect(snap.waxPerLeef).toBe(0);
    expect(snap.warning).toBe("test warning");
  });

  it("stamps the last-good timestamp, never 'now'", () => {
    const before = Date.now();
    const snap = unavailableSnapshot();
    // No live WAX price observed in this session → the never-fetched marker.
    expect(snap.fetchedAt).toBe(NEVER_FETCHED_AT);
    expect(Date.parse(snap.fetchedAt)).toBeLessThan(before);
    expect(snap.waxUsd).toBe(0);
  });

  it("honors a caller-supplied last-good timestamp", () => {
    const snap = unavailableSnapshot("w", "2026-01-01T00:00:00.000Z");
    expect(snap.fetchedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
