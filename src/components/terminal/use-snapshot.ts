import { useEffect, useMemo, useState } from "react";
import { fallbackSnapshot } from "@/lib/leef/fallback";
import { rankPools } from "@/lib/leef/rank";
import { loadSeedSnapshot } from "@/lib/leef/seed";
import type { LeefSnapshot } from "@/lib/leef/types";
import { marketEngine } from "@/lib/market/market-engine";
import { clampSyncSec, DEFAULT_SYNC_SEC, useTerminal } from "@/store/terminal";
import { useMarketEngine } from "@/hooks/useMarketEngine";

const placeholder = fallbackSnapshot(
  "Loading the live Alcor LEEF book…",
  "2026-01-01T00:00:00.000Z",
);

/**
 * Terminal view of the MarketEngine's snapshot. The engine (not React Query,
 * not a component effect) owns the fetch cadence — this hook only subscribes,
 * so prices, routes, balances and strategy state keep updating without any
 * page refresh and regardless of what the component tree does.
 */
export function useSnapshot() {
  const engine = useMarketEngine();
  const syncSec = useTerminal((s) => clampSyncSec(s.syncSec ?? DEFAULT_SYNC_SEC));

  // Instant first paint: the build-time seed book (public/seed-snapshot.json)
  // fills the gap until the market engine's first live pull lands. The engine
  // starts fetching immediately on boot, so the seed is refresh-behind by
  // construction — engine.snapshot replaces it as soon as chain state exists.
  const [seed, setSeed] = useState<LeefSnapshot | null>(null);
  useEffect(() => {
    let live = true;
    void loadSeedSnapshot().then((s) => {
      if (live && s) setSeed(s);
    });
    return () => {
      live = false;
    };
  }, []);

  const snap = engine.snapshot ?? seed ?? placeholder;
  const ranked = useMemo(() => rankPools(snap.pools, snap), [snap]);
  return {
    snap,
    ranked,
    syncSec,
    isFetching: engine.fetching,
    dataUpdatedAt: engine.lastFetchAt,
    refetch: () => {
      void marketEngine.forceRefresh();
    },
    engine,
  };
}
