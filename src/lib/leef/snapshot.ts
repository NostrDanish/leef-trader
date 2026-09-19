import { isWaxToken } from "./amm";
import { fallbackSnapshot } from "./fallback";
import { attachUsdPrices, parseAllPools, parseSwaps } from "./parse";
import { loadTokenRegistry } from "./token-registry";
import type { AuxPool, LeefPool, LeefSnapshot, LiveTrade } from "./types";
import { buildUniverse, mergeUniverseFromBook, repriceUniverse, type UniverseToken } from "./universe";
import { fetchExternalVenues } from "./venue-adapters";
import type { VenuePool } from "./venues";
import { fetchJson } from "@/lib/fetchJson";
import { hotPoolIds } from "@/lib/market/execution-state";

const ALCOR_API = "https://wax.alcor.exchange/api/v2";
const ALCOR_POOLS = `${ALCOR_API}/swap/pools`;
const ALCOR_TOKEN = `${ALCOR_API}/tokens/leef-leefmaincorp`;

/** Full pool-list rediscovery cadence (the list payload is ~11 MB). */
const FULL_REDISCOVERY_MS = 10 * 60_000;
/** Hot-path tracked LEEF books (volume/TVL ranked). Rest refresh in background. */
const HOT_LEEF = 8;
const HOT_AUX = 6;

let cache: { at: number; snap: LeefSnapshot } | null = null;
let lastFullLoadAt = 0;
let tracked: { leef: number[]; aux: number[] } = { leef: [], aux: [] };
let lastUniverse: UniverseToken[] = [];
let lastTrades: LiveTrade[] = [];
let lastVenues: VenuePool[] = [];
let inflight: Promise<LeefSnapshot> | null = null;
let coldInflight = false;

export type SnapshotTimings = {
  snapshotFetchMs: number;
  poolRefreshMs: number;
  tradeHistoryMs: number;
  venueDiscoveryMs: number;
  fullRediscovery: boolean;
};

let lastTimings: SnapshotTimings = {
  snapshotFetchMs: 0,
  poolRefreshMs: 0,
  tradeHistoryMs: 0,
  venueDiscoveryMs: 0,
  fullRediscovery: false,
};

export function lastSnapshotTimings(): SnapshotTimings {
  return lastTimings;
}

async function leefUsdLive(): Promise<number | undefined> {
  try {
    const raw = (await fetchJson(ALCOR_TOKEN, {
      timeoutMs: 4_000,
      priority: "high",
      context: { operation: "Alcor LEEF token price", endpoint: ALCOR_TOKEN },
    })) as {
      usd_price?: number;
      safe_usd_price?: number;
    };
    const n = raw?.safe_usd_price ?? raw?.usd_price;
    return typeof n === "number" && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function relevantAux(aux: AuxPool[], leef: LeefPool[]): AuxPool[] {
  const pairSyms = new Set(leef.map((p) => p.pair.symbol.toUpperCase()));
  pairSyms.add("USDT");
  pairSyms.add("WAXUSDT");
  pairSyms.add("WAXUSDC");
  return aux
    .filter((p) => {
      const a = p.tokenA.symbol.toUpperCase();
      const b = p.tokenB.symbol.toUpperCase();
      const hasWax = isWaxToken(p.tokenA) || isWaxToken(p.tokenB);
      if (!hasWax) return false;
      const other = isWaxToken(p.tokenA) ? b : a;
      return pairSyms.has(other);
    })
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, 40);
}

/** Only parse pools the contract has marked active — dead books misquote routes. */
function parseActivePools(raw: unknown): { leef: LeefPool[]; aux: AuxPool[] } {
  const list = Array.isArray(raw)
    ? raw.filter(
        (p) =>
          p &&
          typeof p === "object" &&
          (p as Record<string, unknown>).active !== false,
      )
    : [];
  return parseAllPools(list);
}

async function fetchPoolById(id: number, priority: "high" | "medium" | "low"): Promise<unknown> {
  return await fetchJson(`${ALCOR_POOLS}/${id}`, {
    timeoutMs: 8_000,
    priority,
    context: { operation: "Alcor pool by id", endpoint: `${ALCOR_POOLS}/${id}`, params: { id } },
  });
}

async function loadFull(): Promise<{
  leef: LeefPool[];
  aux: AuxPool[];
  universe: UniverseToken[];
}> {
  const raw = await fetchJson(ALCOR_POOLS, {
    timeoutMs: 25_000,
    priority: "medium",
    context: { operation: "Alcor full pool list", endpoint: ALCOR_POOLS },
  });
  const parsed = parseActivePools(raw);
  if (parsed.leef.length === 0) {
    throw new Error("No LEEF pools in the Alcor response");
  }
  lastFullLoadAt = Date.now();
  const aux = relevantAux(parsed.aux, parsed.leef);
  const px0 = attachUsdPrices(parsed.leef, aux, undefined, undefined);
  // Venue verification data rides the same load — the universe overlay
  // annotates score/trust and drops scam-flagged tokens.
  await loadTokenRegistry().catch(() => undefined);
  const universe = buildUniverse(
    Array.isArray(raw) ? raw.filter((p) => p && (p as { active?: boolean }).active !== false) : [],
    px0.waxUsd,
  );
  lastUniverse = universe;
  tracked = {
    leef: parsed.leef
      .filter((p) => p.leef.quantity >= 500_000 || p.tvlUsd >= 2 || p.volume24Usd >= 0.5)
      .map((p) => p.id),
    aux: aux.slice(0, 12).map((p) => p.id),
  };
  return { leef: parsed.leef, aux, universe };
}

function applyPoolResults(
  prevLeef: LeefPool[],
  prevAux: AuxPool[],
  ids: number[],
  results: PromiseSettledResult<unknown>[],
): { leef: LeefPool[]; aux: AuxPool[] } {
  const leefById = new Map(prevLeef.map((p) => [p.id, p]));
  const auxById = new Map(prevAux.map((p) => [p.id, p]));
  results.forEach((r, i) => {
    if (r.status !== "fulfilled" || !r.value) return;
    const parsed = parseActivePools([r.value]);
    const id = ids[i]!;
    const leefHit = parsed.leef.find((p) => p.id === id);
    if (leefHit) {
      leefById.set(id, leefHit);
      return;
    }
    const auxHit = parsed.aux.find((p) => p.id === id);
    if (auxHit) {
      auxById.set(id, auxHit);
      return;
    }
    leefById.delete(id);
    auxById.delete(id);
  });
  const leef = [...leefById.values()];
  if (leef.length === 0) throw new Error("All tracked LEEF pools dropped");
  return { leef, aux: [...auxById.values()] };
}

/**
 * Hot-path refresh: only the books the router actually needs this cycle —
 * the ONE shared hot-pool definition (hotPoolIds, P-C) — plus the head of
 * the tracked registry (registry maintenance, not freshness semantics).
 * Remaining tracked ids refresh in the background and never block a trade
 * decision.
 */
async function loadTrackedHot(
  prevLeef: LeefPool[],
  prevAux: AuxPool[],
): Promise<{ leef: LeefPool[]; aux: AuxPool[] }> {
  const ids = [
    ...new Set([
      ...hotPoolIds({ pools: prevLeef, aux: prevAux }),
      ...tracked.leef.slice(0, HOT_LEEF),
      ...tracked.aux.slice(0, HOT_AUX),
    ]),
  ];
  const results = await Promise.allSettled(ids.map((id) => fetchPoolById(id, "high")));
  return applyPoolResults(prevLeef, prevAux, ids, results);
}

async function loadTrades(pools: LeefPool[]): Promise<LiveTrade[]> {
  const top = [...pools]
    .filter((p) => p.volume24Usd >= 0.5 || p.tvlUsd >= 80)
    .sort((a, b) => b.volume24Usd - a.volume24Usd)
    .slice(0, 4);
  const results = await Promise.allSettled(
    top.map((p) =>
      fetchJson(`${ALCOR_POOLS}/${p.id}/swaps`, {
        timeoutMs: 8_000,
        priority: "low",
        context: { operation: "Alcor pool swaps", endpoint: `${ALCOR_POOLS}/${p.id}/swaps`, params: { poolId: p.id } },
      }),
    ),
  );
  const trades: LiveTrade[] = [];
  results.forEach((r, i) => {
    const pool = top[i];
    if (!pool || r.status !== "fulfilled") return;
    trades.push(...parseSwaps(r.value, pool).slice(0, 40));
  });
  trades.sort((a, b) => b.timestamp - a.timestamp);
  return trades.slice(0, 60);
}

function venueAuxOf(venues: VenuePool[]): AuxPool[] {
  return venues.map((v) => ({
    id: v.id,
    fee: v.fee,
    feePct: v.feePct,
    tokenA: v.tokenA,
    tokenB: v.tokenB,
    tvlUsd: v.tvlUsd,
    volume24Usd: 0,
    venue: v.venue,
  }));
}

function mergeSnap(book: {
  leef: LeefPool[];
  aux: AuxPool[];
  leefUsdHint?: number;
}): LeefSnapshot {
  const px = attachUsdPrices(book.leef, book.aux, undefined, book.leefUsdHint);
  book.leef.sort((a, b) => b.volume24Usd - a.volume24Usd || b.tvlUsd - a.tvlUsd);
  const universe = mergeUniverseFromBook(
    repriceUniverse(lastUniverse, book.aux, px.waxUsd),
    book.leef,
    book.aux,
    px.waxUsd,
    px.leefUsd,
  );
  lastUniverse = universe;
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    waxUsd: px.waxUsd,
    leefUsd: px.leefUsd,
    waxPerLeef: px.waxPerLeef,
    waxConfidence: px.waxConfidence,
    waxSources: px.waxSources,
    waxDispersionPct: px.waxDispersionPct,
    pools: book.leef,
    aux: [...book.aux.filter((p) => !p.venue || p.venue === "alcor"), ...venueAuxOf(lastVenues)],
    trades: lastTrades,
    universe,
    venues: lastVenues,
  };
}

/** Cold path: tape, remaining tracked pools, Defibox/Taco topology. Never blocks. */
function kickCold(leef: LeefPool[], aux: AuxPool[]): void {
  if (coldInflight) return;
  coldInflight = true;
  void (async () => {
    const t0 = Date.now();
    try {
      const restLeef = tracked.leef.filter(
        (id) => !leef.slice(0, HOT_LEEF).some((p) => p.id === id),
      );
      const restAux = tracked.aux.slice(HOT_AUX);
      const restIds = [...restLeef, ...restAux];
      const [trades, venues, rest] = await Promise.all([
        loadTrades(leef).catch(() => lastTrades),
        fetchExternalVenues(cache?.snap.waxUsd ?? 0).catch(() => lastVenues),
        restIds.length
          ? Promise.allSettled(restIds.map((id) => fetchPoolById(id, "low"))).then((r) =>
              applyPoolResults(leef, aux, restIds, r),
            )
          : Promise.resolve({ leef, aux }),
      ]);
      lastTrades = trades;
      lastVenues = venues;
      lastTimings = {
        ...lastTimings,
        tradeHistoryMs: Date.now() - t0,
        venueDiscoveryMs: Date.now() - t0,
      };
      if (cache) {
        const book = rest;
        cache = {
          at: Date.now(),
          snap: {
            ...mergeSnap({ leef: book.leef, aux: book.aux, leefUsdHint: cache.snap.leefUsd }),
            // Keep the hot fetchedAt so the bot doesn't think the book aged
            // just because analytics landed.
            fetchedAt: cache.snap.fetchedAt,
            waxUsd: cache.snap.waxUsd,
            leefUsd: cache.snap.leefUsd,
            waxPerLeef: cache.snap.waxPerLeef,
            trades: lastTrades,
            venues: lastVenues,
          },
        };
      }
    } catch {
      /* cold path is best-effort */
    } finally {
      coldInflight = false;
    }
  })();
}

async function loadHot(): Promise<LeefSnapshot> {
  const t0 = Date.now();
  const needFull =
    lastFullLoadAt === 0 ||
    Date.now() - lastFullLoadAt > FULL_REDISCOVERY_MS ||
    tracked.leef.length === 0;

  const tPools = Date.now();
  const [book, leefUsdHint] = await Promise.all([
    needFull
      ? loadFull()
      : loadTrackedHot(cache?.snap.pools ?? [], cache?.snap.aux ?? []),
    leefUsdLive(),
  ]);
  const poolRefreshMs = Date.now() - tPools;

  const snap = mergeSnap({
    leef: book.leef,
    aux: "universe" in book ? book.aux : book.aux,
    leefUsdHint,
  });
  lastTimings = {
    snapshotFetchMs: Date.now() - t0,
    poolRefreshMs,
    tradeHistoryMs: lastTimings.tradeHistoryMs,
    venueDiscoveryMs: lastTimings.venueDiscoveryMs,
    fullRediscovery: needFull,
  };
  kickCold(book.leef, book.aux);
  return snap;
}

/**
 * Fetch the current LEEF book from Alcor's public API.
 * In-flight calls are deduplicated; falls back to the last live book (or a
 * static snapshot) when the API is unreachable.
 *
 * HOT PATH: tracked pool state + prices. Tape, remaining pools, and
 * Defibox/Taco topology refresh in the background and never block a trade.
 */
export async function getLeefSnapshot(): Promise<LeefSnapshot> {
  if (import.meta.env.MODE === "test") {
    return fallbackSnapshot("Test mode — static book.", new Date().toISOString());
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const snap = await loadHot();
      cache = { at: Date.now(), snap };
      return snap;
    } catch (err) {
      if (cache) return { ...cache.snap, warning: "Using last live book." };
      const raw = err instanceof Error ? err.message : "Alcor fetch failed";
      return fallbackSnapshot(
        `Live book unavailable (${raw}). Showing the last known LEEF pools.`,
        new Date().toISOString(),
      );
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Alias: trading engine consumes MarketState, not the full analytics blob. */
export const getMarketSnapshot = getLeefSnapshot;
