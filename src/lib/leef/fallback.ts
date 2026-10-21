import type { LeefSnapshot } from "./types";
import { lastKnownWaxUsd } from "./parse";

/** Honest "never seen" marker — no live book was ever observed this session. */
export const NEVER_FETCHED_AT = "1970-01-01T00:00:00.000Z";

/**
 * Honest no-data shape for when the live Alcor book is unreachable and no
 * cached live book exists: EMPTY collections plus the last-good observation
 * timestamp (the persisted last-known WAX price time, or NEVER_FETCHED_AT).
 * The only number carried is the last KNOWN live WAX/USD price with its own
 * provenance — never a fabricated pool, trade, volume, or price.
 */
export function unavailableSnapshot(warning?: string, fetchedAt?: string): LeefSnapshot {
  const known = lastKnownWaxUsd();
  return {
    source: "unavailable",
    fetchedAt: fetchedAt ?? (known.at > 0 ? new Date(known.at).toISOString() : NEVER_FETCHED_AT),
    waxUsd: known.usd,
    leefUsd: 0,
    waxPerLeef: 0,
    pools: [],
    aux: [],
    trades: [],
    universe: [],
    venues: [],
    warning: warning ?? "Live market data is unavailable from this session.",
  };
}

/** @deprecated Alias kept for the UI placeholder; same honest empty shape. */
export const fallbackSnapshot = unavailableSnapshot;
