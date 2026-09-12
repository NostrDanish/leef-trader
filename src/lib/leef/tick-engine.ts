import { backedPools } from "./amm";
import type { LeefPool } from "./types";

/**
 * Static terminal pool selector.
 *
 * Synthetic candles, seeded price movement, UI indicator presets and
 * pause/play ticker state were removed. The actual bot signal engine remains
 * in bot-engine.ts and consumes only real MarketEngine snapshots.
 */
export function pickTickPool(pools: LeefPool[], id: number | null): LeefPool | undefined {
  const backed = backedPools(pools);
  if (id != null) {
    const selected = backed.find((p) => p.id === id);
    if (selected) return selected;
  }
  return [...backed].sort((a, b) => b.tvlUsd - a.tvlUsd)[0];
}
