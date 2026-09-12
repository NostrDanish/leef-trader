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

function criticalIds(snap: LeefSnapshot, route?: SwapRoute | null): number[] {
  const routeIds = route?.poolIds.filter((id) => id < 1_000_000) ?? [];
  const waxPriceIds = snap.aux
    .filter(
      (p) => p.tokenA.symbol === "WAX" || p.tokenB.symbol === "WAX",
    )
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, 2)
    .map((p) => p.id);
  const mainLeefWax = snap.pools
    .filter((p) => p.pair.symbol === "WAX")
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, 1)
    .map((p) => p.id);
  return [...new Set([...routeIds, ...waxPriceIds, ...mainLeefWax])];
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
  const ids = criticalIds(snap, route);
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
