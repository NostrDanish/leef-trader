import { attachUsdPrices, parseAllPools } from "./parse";
import type { LeefSnapshot } from "./types";

/**
 * Build-time seed book (public/seed-snapshot.json, written by
 * tools/seed-snapshot.mjs). The terminal paints from it instantly on first
 * load when it is fresh; the live market engine replaces it seconds later
 * (refresh-behind).
 */

export const SEED_MAX_AGE_MS = 30 * 60_000;
const SEED_URL = "/seed-snapshot.json";

type SeedFile = {
  v?: unknown;
  fetchedAt?: unknown;
  leefUsdHint?: unknown;
  pools?: unknown;
};

/**
 * Validate and convert a raw seed file into a snapshot. Returns null for
 * anything missing, malformed, or older than SEED_MAX_AGE_MS.
 *
 * The seed is deliberately marked `source: "fallback"` (never "live"): it
 * is a minutes-old static book, so it must not unlock live trading or pose
 * as chain state. It carries no `warning`, so no fallback banner shows —
 * the header simply reads "Cached book" until the live pull lands.
 */
export function seedToSnapshot(raw: unknown, now: number = Date.now()): LeefSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const file = raw as SeedFile;
  if (typeof file.fetchedAt !== "string") return null;
  const at = Date.parse(file.fetchedAt);
  // Reject stale seeds and clock-skewed "future" seeds (>1 min ahead).
  if (!Number.isFinite(at) || now - at > SEED_MAX_AGE_MS || at > now + 60_000) return null;
  if (!Array.isArray(file.pools) || file.pools.length === 0) return null;

  const active = file.pools.filter(
    (p) => p && typeof p === "object" && (p as { active?: boolean }).active !== false,
  );
  const { leef, aux } = parseAllPools(active);
  if (leef.length === 0) return null;

  const hint =
    typeof file.leefUsdHint === "number" && file.leefUsdHint > 0
      ? file.leefUsdHint
      : undefined;
  const px = attachUsdPrices(leef, aux, undefined, hint);
  leef.sort((a, b) => b.volume24Usd - a.volume24Usd || b.tvlUsd - a.tvlUsd);

  return {
    source: "fallback",
    fetchedAt: file.fetchedAt,
    waxUsd: px.waxUsd,
    leefUsd: px.leefUsd,
    waxPerLeef: px.waxPerLeef,
    waxConfidence: px.waxConfidence,
    waxSources: px.waxSources,
    waxDispersionPct: px.waxDispersionPct,
    pools: leef,
    aux,
    trades: [],
    universe: [],
    venues: [],
  };
}

let inflight: Promise<LeefSnapshot | null> | null = null;

/**
 * Fetch the seed book once per page load. Never throws: null when the file
 * is absent (prebuild skipped), stale, or invalid.
 */
export function loadSeedSnapshot(): Promise<LeefSnapshot | null> {
  if (import.meta.env.MODE === "test") return Promise.resolve(null);
  if (!inflight) {
    inflight = (async () => {
      const res = await fetch(SEED_URL);
      if (!res.ok) return null;
      return seedToSnapshot(await res.json());
    })().catch(() => null);
  }
  return inflight;
}
