import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fallbackSnapshot } from "@/lib/leef/fallback";
import { rankPools } from "@/lib/leef/rank";
import { getLeefSnapshot } from "@/lib/leef/snapshot";
import { clampSyncSec, DEFAULT_SYNC_SEC, useTerminal } from "@/store/terminal";

const placeholder = fallbackSnapshot(
  "Loading the live Alcor LEEF book…",
  "2026-01-01T00:00:00.000Z",
);

export function useSnapshot() {
  const syncSec = useTerminal((s) => clampSyncSec(s.syncSec ?? DEFAULT_SYNC_SEC));
  const intervalMs = syncSec * 1000;

  const q = useQuery({
    queryKey: ["leef-snapshot", syncSec],
    queryFn: () => getLeefSnapshot(),
    refetchInterval: intervalMs,
    placeholderData: placeholder,
    staleTime: Math.max(1_000, intervalMs - 2_000),
    retry: 1,
  });

  const snap = q.data ?? placeholder;
  const ranked = useMemo(() => rankPools(snap.pools, snap), [snap]);
  return { ...q, snap, ranked, syncSec };
}
