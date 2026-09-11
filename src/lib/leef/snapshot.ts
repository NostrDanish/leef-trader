import { isWaxToken } from "./amm";
import { fallbackSnapshot } from "./fallback";
import { attachUsdPrices, parseAllPools, parseSwaps } from "./parse";
import type { AuxPool, LeefPool, LeefSnapshot, LiveTrade } from "./types";
import { buildUniverse, repriceUniverse, type UniverseToken } from "./universe";
import { fetchJson } from "@/lib/fetchJson";

const ALCOR_API = "https://wax.alcor.exchange/api/v2";
const ALCOR_POOLS = `${ALCOR_API}/swap/pools`;
const ALCOR_TOKEN = `${ALCOR_API}/tokens/leef-leefmaincorp`;

/** Full pool-list rediscovery cadence (the list payload is ~11 MB). */
const FULL_REDISCOVERY_MS = 10 * 60_000;

let cache: { at: number; snap: LeefSnapshot } | null = null;
let lastFullLoadAt = 0;
let tracked: { leef: number[]; aux: number[] } = { leef: [], aux: [] };
let lastUniverse: UniverseToken[] = [];
let inflight: Promise<LeefSnapshot> | null = null;

async function leefUsdLive(): Promise<number | undefined> {
  try {
    const raw = (await fetchJson(ALCOR_TOKEN, { timeoutMs: 5_000 })) as {
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

async function fetchPoolById(id: number): Promise<unknown> {
  return await fetchJson(`${ALCOR_POOLS}/${id}`, { timeoutMs: 10_000 });
}

async function loadFull(): Promise<{
  leef: LeefPool[];
  aux: AuxPool[];
  universe: UniverseToken[];
}> {
  const raw = await fetchJson(ALCOR_POOLS, { timeoutMs: 25_000 });
  const parsed = parseActivePools(raw);
  if (parsed.leef.length === 0) {
    throw new Error("No LEEF pools in the Alcor response");
  }
  lastFullLoadAt = Date.now();
  const aux = relevantAux(parsed.aux, parsed.leef);
  // Price the token universe off the same raw book (needs a WAX/USD anchor).
  const px0 = attachUsdPrices(parsed.leef, aux, undefined, undefined);
  const universe = buildUniverse(
    Array.isArray(raw) ? raw.filter((p) => p && (p as { active?: boolean }).active !== false) : [],
    px0.waxUsd,
  );
  lastUniverse = universe;
  tracked = {
    leef: parsed.leef.map((p) => p.id),
    aux: [...new Set([...aux.map((p) => p.id), ...universe.map((t) => t.poolId)])],
  };
  return { leef: parsed.leef, aux, universe };
}

/**
 * Refresh only the tracked pools by id (~1 KB each) instead of re-downloading
 * the full ~11 MB pool list on every tick.
 */
async function loadTracked(
  prevLeef: LeefPool[],
  prevAux: AuxPool[],
): Promise<{ leef: LeefPool[]; aux: AuxPool[] }> {
  const ids = [...tracked.leef, ...tracked.aux];
  const results = await Promise.allSettled(ids.map((id) => fetchPoolById(id)));

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
    // Pool turned inactive or unparseable — drop it from the book.
    leefById.delete(id);
    auxById.delete(id);
  });

  const leef = [...leefById.values()];
  if (leef.length === 0) throw new Error("All tracked LEEF pools dropped");
  return { leef, aux: [...auxById.values()] };
}

async function loadTrades(pools: LeefPool[]): Promise<LiveTrade[]> {
  const top = [...pools]
    .filter((p) => p.volume24Usd >= 0.5 || p.tvlUsd >= 80)
    .sort((a, b) => b.volume24Usd - a.volume24Usd)
    .slice(0, 4);
  const results = await Promise.allSettled(
    top.map((p) => fetchJson(`${ALCOR_POOLS}/${p.id}/swaps`, { timeoutMs: 8_000 })),
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

async function loadLive(): Promise<LeefSnapshot> {
  const needFull =
    lastFullLoadAt === 0 ||
    Date.now() - lastFullLoadAt > FULL_REDISCOVERY_MS ||
    tracked.leef.length === 0;

  const [book, leefUsdHint] = await Promise.all([
    needFull
      ? loadFull()
      : loadTracked(
          cache?.snap.pools ?? fallbackPoolsSnapshot().pools,
          cache?.snap.aux ?? [],
        ).catch(() => loadFull()),
    leefUsdLive(),
  ]);

  const px = attachUsdPrices(book.leef, book.aux, undefined, leefUsdHint);
  book.leef.sort((a, b) => b.volume24Usd - a.volume24Usd || b.tvlUsd - a.tvlUsd);
  const universe = repriceUniverse(lastUniverse, book.aux, px.waxUsd);
  const trades = await loadTrades(book.leef);

  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    waxUsd: px.waxUsd,
    leefUsd: px.leefUsd,
    waxPerLeef: px.waxPerLeef,
    pools: book.leef,
    aux: book.aux,
    trades,
    universe,
  };
}

function fallbackPoolsSnapshot(): LeefSnapshot {
  return fallbackSnapshot(undefined, new Date().toISOString());
}

/**
 * Fetch the current LEEF book from Alcor's public API.
 * In-flight calls are deduplicated; falls back to the last live book (or a
 * static snapshot) when the API is unreachable.
 */
export async function getLeefSnapshot(): Promise<LeefSnapshot> {
  // Hermetic test runs: never hit the network from vitest/jsdom.
  if (import.meta.env.MODE === "test") {
    return fallbackSnapshot("Test mode — static book.", new Date().toISOString());
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const snap = await loadLive();
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
