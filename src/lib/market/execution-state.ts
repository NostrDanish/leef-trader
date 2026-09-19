/**
 * Compact execution state.
 *
 * The background MarketEngine owns discovery/history/universe analytics.
 * Immediately before capital moves we refresh ONLY pools the candidate route
 * depends on (plus its WAX/stable price references), not the entire snapshot.
 * The final venue-specific executable quote remains authoritative at sign time.
 */
import { attachUsdPrices } from "@/lib/leef/parse";
import type { AuxPool, LeefPool, LeefSnapshot, SwapRoute } from "@/lib/leef/types";
import {
  applyOnchainToAuxPool,
  applyOnchainToLeefPool,
  fetchOnchainPools,
} from "@/lib/wax/alcor-onchain";

export type ExecutionMarketState = {
  snap: LeefSnapshot;
  refreshedPoolIds: number[];
  missingPoolIds: number[];
  refreshedAt: number;
  refreshMs: number;
  source: "cache" | "onchain";
};

/* ------------------------------------------------------------------ */
/* The ONE hot-pool definition (P-C)                                   */
/* ------------------------------------------------------------------ */

/** Top LEEF books (volume, then TVL) that must always be fresh to trade. */
const HOT_TOP_LEEF = 8;
/** WAX-quoted LEEF books — the WAX/LEEF price references. */
const HOT_WAX_QUOTED_LEEF = 4;
/** Deepest WAX-side aux books — the WAX/stable price references. */
const HOT_WAX_AUX = 4;

/**
 * One definition of "what must be fresh to trade", consumed by all three
 * hot-pool readers (previously three divergent sets — audit gap D4):
 *
 *   - market-engine's on-chain spot loop (patches hot books between API pulls)
 *   - snapshot's tracked-hot API refresh (also unions its tracked registry ids
 *     on top — registry maintenance, not freshness semantics)
 *   - the gate's route-critical refresh below (passes `route`; route pool ids
 *     are ALWAYS in the set, venue-namespaced ids ≥ 1_000_000 excluded — they
 *     are not Alcor on-chain rows)
 *
 * `snap` is structurally `Pick<LeefSnapshot, "pools" | "aux">` so snapshot's
 * loader can call it before a full snapshot exists.
 */
export function hotPoolIds(
  snap: Pick<LeefSnapshot, "pools" | "aux">,
  opts?: { route?: SwapRoute | null },
): number[] {
  const routeIds = opts?.route?.poolIds.filter((id) => id < 1_000_000) ?? [];
  const rankedLeef = [...snap.pools].sort(
    (a, b) => b.volume24Usd - a.volume24Usd || b.tvlUsd - a.tvlUsd,
  );
  const topLeef = rankedLeef.slice(0, HOT_TOP_LEEF).map((p) => p.id);
  const waxQuoted = rankedLeef
    .filter((p) => p.pair.symbol.toUpperCase() === "WAX")
    .slice(0, HOT_WAX_QUOTED_LEEF)
    .map((p) => p.id);
  const waxAux = snap.aux
    .filter(
      (p) =>
        p.tokenA.symbol.toUpperCase() === "WAX" || p.tokenB.symbol.toUpperCase() === "WAX",
    )
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, HOT_WAX_AUX)
    .map((p) => p.id);
  return [...new Set([...routeIds, ...waxQuoted, ...topLeef, ...waxAux])];
}

export function executionStateFresh(snap: LeefSnapshot, maxAgeMs = 8_000, now = Date.now()): boolean {
  const at = Date.parse(snap.spotAt ?? snap.fetchedAt);
  return Number.isFinite(at) && now - at <= maxAgeMs;
}

/** Refresh only route-critical on-chain Alcor rows; never runs full discovery. */
export async function refreshExecutionState(
  snap: LeefSnapshot,
  route?: SwapRoute | null,
  maxAgeMs = 8_000,
): Promise<ExecutionMarketState> {
  const t0 = Date.now();
  if (executionStateFresh(snap, maxAgeMs)) {
    return {
      snap,
      refreshedPoolIds: [],
      missingPoolIds: [],
      refreshedAt: Date.now(),
      refreshMs: 0,
      source: "cache",
    };
  }
  const ids = hotPoolIds(snap, { route });
  const rows = await fetchOnchainPools(ids);
  const nextLeef: LeefPool[] = [...snap.pools];
  const nextAux: AuxPool[] = [...snap.aux];
  const refreshedPoolIds: number[] = [];
  for (const [id, row] of rows) {
    const li = nextLeef.findIndex((p) => p.id === id);
    if (li >= 0) {
      const patched = applyOnchainToLeefPool(nextLeef[li]!, row);
      if (patched) {
        nextLeef[li] = patched;
        refreshedPoolIds.push(id);
      }
      continue;
    }
    const ai = nextAux.findIndex((p) => p.id === id);
    if (ai >= 0) {
      const patched = applyOnchainToAuxPool(nextAux[ai]!, row);
      if (patched) {
        nextAux[ai] = patched;
        refreshedPoolIds.push(id);
      }
    }
  }
  const missingPoolIds = ids.filter((id) => !rows.has(id));
  if (route && route.poolIds.some((id) => id < 1_000_000 && missingPoolIds.includes(id))) {
    throw new Error(`Critical route pool unavailable: ${missingPoolIds.join(", ")}`);
  }
  const px = attachUsdPrices(nextLeef, nextAux, snap.waxUsd, undefined);
  const patched: LeefSnapshot = {
    ...snap,
    pools: nextLeef,
    aux: nextAux,
    waxUsd: px.waxUsd,
    leefUsd: px.leefUsd,
    waxPerLeef: px.waxPerLeef,
    spotAt: new Date().toISOString(),
  };
  return {
    snap: patched,
    refreshedPoolIds,
    missingPoolIds,
    refreshedAt: Date.now(),
    refreshMs: Date.now() - t0,
    source: "onchain",
  };
}
