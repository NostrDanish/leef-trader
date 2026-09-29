import { describe, expect, it } from "vitest";
import {
  normalizeRejectionMessage,
  rejectionKey,
  RETRY_STORM_LIMIT,
  trackRejection,
  type RejectionStreak,
} from "./retry-storm";

const key = (message: string) =>
  rejectionKey({ message, strategy: "arb", pair: "PARAUSD/LEEF" });

describe("normalizeRejectionMessage", () => {
  it("collapses amounts so re-sized replans of the same failure match", () => {
    expect(normalizeRejectionMessage("overdrawn balance: 12.50000000 WAX")).toBe(
      normalizeRejectionMessage("overdrawn balance: 11.90000000 WAX"),
    );
  });

  it("strips the eosio_assert wrapper and case", () => {
    expect(
      normalizeRejectionMessage("assertion failure with message: Received lower than minTokenOut: 30"),
    ).toBe(normalizeRejectionMessage("received lower than mintokenout: 42"));
  });

  it("keeps distinct failure classes distinct", () => {
    expect(normalizeRejectionMessage("overdrawn balance: 1 WAX")).not.toBe(
      normalizeRejectionMessage("symbol precision mismatch: 1 WAX"),
    );
  });
});

describe("trackRejection", () => {
  it("halts after 3 identical consecutive rejections", () => {
    const k = key("assertion failure with message: overdrawn balance: 1.5 PARAUSD");
    let streak: RejectionStreak | null = null;
    let halted = false;
    for (let i = 0; i < RETRY_STORM_LIMIT - 1; i++) {
      ({ streak, halted } = trackRejection(streak, k));
      expect(halted).toBe(false);
      expect(streak.count).toBe(i + 1);
    }
    ({ streak, halted } = trackRejection(streak, k));
    expect(halted).toBe(true);
    expect(streak.count).toBe(RETRY_STORM_LIMIT);
    // Stays halted while the same failure keeps arriving.
    ({ halted } = trackRejection(streak, k));
    expect(halted).toBe(true);
  });

  it("treats re-sized amounts of the same assertion as identical", () => {
    let streak: RejectionStreak | null = null;
    streak = trackRejection(streak, key("overdrawn balance: 10.0 WAX")).streak;
    streak = trackRejection(streak, key("overdrawn balance: 9.7 WAX")).streak;
    const { halted } = trackRejection(streak, key("overdrawn balance: 9.4 WAX"));
    expect(halted).toBe(true);
  });

  it("a different error message resets the counter", () => {
    let streak: RejectionStreak | null = null;
    streak = trackRejection(streak, key("overdrawn balance: 1 WAX")).streak;
    streak = trackRejection(streak, key("overdrawn balance: 2 WAX")).streak;
    // Third failure is a DIFFERENT assertion → restart at 1, no halt.
    const r = trackRejection(streak, key("Received lower than minTokenOut: 30"));
    expect(r.halted).toBe(false);
    expect(r.streak.count).toBe(1);
  });

  it("a different pair or strategy resets the counter", () => {
    let streak: RejectionStreak | null = null;
    streak = trackRejection(streak, key("overdrawn balance: 1 WAX")).streak;
    streak = trackRejection(streak, key("overdrawn balance: 2 WAX")).streak;
    const otherPair = rejectionKey({
      message: "overdrawn balance: 3 WAX",
      strategy: "arb",
      pair: "WAX/LEEF",
    });
    expect(trackRejection(streak, otherPair).streak.count).toBe(1);
    const otherStrategy = rejectionKey({
      message: "overdrawn balance: 3 WAX",
      strategy: "grid",
      pair: "PARAUSD/LEEF",
    });
    expect(trackRejection(streak, otherStrategy).streak.count).toBe(1);
  });

  it("resume (clearing the streak) restarts counting from zero", () => {
    const k = key("overdrawn balance: 1 WAX");
    let streak: RejectionStreak | null = null;
    for (let i = 0; i < RETRY_STORM_LIMIT; i++) streak = trackRejection(streak, k).streak;
    // Manual resume clears the streak — the next rejection counts fresh.
    streak = null;
    const { streak: next, halted } = trackRejection(streak, k);
    expect(halted).toBe(false);
    expect(next.count).toBe(1);
  });
});
