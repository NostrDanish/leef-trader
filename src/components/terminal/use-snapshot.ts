import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fallbackSnapshot } from "@/lib/leef/fallback";
import { rankPools } from "@/lib/leef/rank";
import { getLeefSnapshot } from "@/lib/leef/snapshot";

const placeholder = fallbackSnapshot(
  "Loading the live Alcor LEEF book…",
  "2026-01-01T00:00:00.000Z",
);

export function useSnapshot() {
  const q = useQuery({
    queryKey: ["leef-snapshot"],
    queryFn: () => getLeefSnapshot(),
    refetchInterval: 30_000,
    placeholderData: placeholder,
    staleTime: 20_000,
    retry: 1,
  });

  const snap = q.data ?? placeholder;
  const ranked = useMemo(() => rankPools(snap.pools, snap), [snap]);
  return { ...q, snap, ranked };
}
