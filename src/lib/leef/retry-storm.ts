/**
 * Retry-storm guard: a deterministically reverting transaction (same
 * on-chain assertion every cycle) must never be re-pushed forever — WAX
 * nodes greylist accounts that produce too many failed transactions
 * (~24 h cooldown), which is exactly what an unguarded retry loop trips.
 *
 * This module is the pure decision logic: track consecutive IDENTICAL
 * on-chain rejections keyed by (strategy, pair, normalized assertion
 * message). After RETRY_STORM_LIMIT identical consecutive rejections the
 * caller halts the strategy and requires a manual resume. A different
 * error message (or a resume) resets the streak.
 *
 * Kept store-free so the logic is unit-testable; the stores only persist
 * the streak + halt flag this module computes.
 */

/** Identical consecutive on-chain rejections before the strategy halts. */
export const RETRY_STORM_LIMIT = 3;

export type RejectionStreak = {
  /** rejectionKey() of the current consecutive run. */
  key: string;
  /** Consecutive rejections seen for this key. */
  count: number;
};

/**
 * Normalize an assertion/error message for identity comparison: digits are
 * the only part of a re-planned deterministic revert that drifts (re-sized
 * amounts, fresh tx ids, timestamps), so they collapse to `#` — two cycles
 * of "overdrawn balance: 12.5 WAX" / "overdrawn balance: 11.9 WAX" are the
 * SAME failure, while "overdrawn balance" vs "Received lower than
 * minTokenOut" are not.
 */
export function normalizeRejectionMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/assertion failure with message:?\s*/i, "")
    .replace(/0x[0-9a-f]+/g, "#")
    .replace(/\d+(?:\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** Identity of one rejection: strategy + traded pair + normalized message. */
export function rejectionKey(opts: {
  message: string;
  strategy: string;
  pair: string;
}): string {
  return `${opts.strategy}|${opts.pair.toUpperCase()}|${normalizeRejectionMessage(opts.message)}`;
}

/**
 * Advance the streak for one on-chain rejection. Same key as the previous
 * rejection → count + 1; anything else (different message, strategy, or
 * pair) → the streak restarts at 1. `halted` flips true once the streak
 * reaches the limit and stays true while the same failure keeps coming —
 * the caller is expected to stop pushing at that point.
 */
export function trackRejection(
  prev: RejectionStreak | null | undefined,
  key: string,
  limit: number = RETRY_STORM_LIMIT,
): { streak: RejectionStreak; halted: boolean } {
  const count = prev && prev.key === key ? prev.count + 1 : 1;
  return { streak: { key, count }, halted: count >= limit };
}
