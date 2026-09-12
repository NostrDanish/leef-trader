/**
 * Dependency-aware route invalidation.
 *
 * A route is only as fresh as the pools it depends on. Every tracked pool has
 * a version counter; when on-chain state or an API pull changes a pool, its
 * version bumps and every cached route touching it is invalidated — while
 * routes on UNRELATED pools stay valid. An NFT mint changing some random
 * table does not invalidate the LEEF/WAX route.
 */
import type { LeefPool, SwapRoute } from "@/lib/leef/types";

export type CachedRouteEntry = {
  /** Caller's identity for the computation (e.g. "swap:WAX>LEEF"). */
  key: string;
  /** Fingerprint of the computation inputs (amount, tokens, knobs). */
  inputsKey: string;
  /** The computed route list (full ranking, not just the best). */
  routes: SwapRoute[];
  poolIds: number[];
  /** Pool versions the routes were computed against. */
  poolVersions: Record<number, number>;
  createdAt: number;
};

/** Fields that matter for pool-state identity. */
export function poolFingerprint(p: LeefPool): string {
  return [
    p.sqrtPriceX64 ?? "0",
    p.liquidity,
    p.leef.quantity,
    p.pair.quantity,
    p.pairPerLeef,
  ].join("|");
}

export class RouteCache {
  private versions = new Map<number, number>();
  private prints = new Map<number, string>();
  private entries = new Map<string, CachedRouteEntry>();

  versionOf(poolId: number): number {
    return this.versions.get(poolId) ?? 0;
  }

  /**
   * Compare incoming pool rows with the last fingerprint; bump the version
   * of every pool that meaningfully changed. Returns the changed ids —
   * unchanged pools keep their routes valid.
   */
  notePools(pools: LeefPool[]): number[] {
    const changed: number[] = [];
    for (const p of pools) {
      const fp = poolFingerprint(p);
      if (this.prints.get(p.id) !== fp) {
        this.prints.set(p.id, fp);
        this.versions.set(p.id, (this.versions.get(p.id) ?? 0) + 1);
        changed.push(p.id);
      }
    }
    return changed;
  }

  /** Explicit invalidation (e.g. browser resume — nothing can be trusted). */
  invalidateAll(): void {
    for (const id of this.prints.keys()) {
      this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    }
    this.entries.clear();
  }

  bumpPool(poolId: number): void {
    this.versions.set(poolId, (this.versions.get(poolId) ?? 0) + 1);
  }

  put(entry: Omit<CachedRouteEntry, "createdAt">): void {
    this.entries.set(entry.key, { ...entry, createdAt: Date.now() });
  }

  get(key: string): CachedRouteEntry | null {
    return this.entries.get(key) ?? null;
  }

  /** None of the entry's dependency pools bumped since it was computed. */
  isFresh(entry: CachedRouteEntry): boolean {
    for (const id of entry.poolIds) {
      if (this.versionOf(id) !== entry.poolVersions[id]) return false;
    }
    return true;
  }

  /** Status-panel stats: cached routes still dependency-valid vs dropped. */
  stats(): { fresh: number; stale: number; trackedPools: number } {
    let fresh = 0;
    let stale = 0;
    for (const [key, entry] of this.entries) {
      if (this.isFresh(entry)) {
        fresh++;
      } else {
        stale++;
        this.entries.delete(key);
      }
    }
    return { fresh, stale, trackedPools: this.prints.size };
  }

  clear(): void {
    this.entries.clear();
    this.prints.clear();
    this.versions.clear();
  }
}

export const routeCache = new RouteCache();

/**
 * Memoized route computation with dependency awareness: recompute only when
 * the involved pool versions or the inputs change. Nothing relevant changed
 * → the previous list is returned as-is (same references, so downstream
 * React memos hold too).
 */
export function routesCached(
  compute: () => SwapRoute[],
  opts: { key: string; poolIds: number[]; inputsKey: string },
): SwapRoute[] {
  const versions: Record<number, number> = {};
  for (const id of opts.poolIds) versions[id] = routeCache.versionOf(id);
  const entry = routeCache.get(opts.key);
  if (
    entry &&
    entry.inputsKey === opts.inputsKey &&
    opts.poolIds.every((id) => versions[id] === entry.poolVersions[id])
  ) {
    return entry.routes;
  }
  const routes = compute();
  if (routes.length > 0) {
    routeCache.put({
      key: opts.key,
      inputsKey: opts.inputsKey,
      routes,
      poolIds: opts.poolIds,
      poolVersions: versions,
    });
  }
  return routes;
}
