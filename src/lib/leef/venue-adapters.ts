/**
 * Venue adapters — on-chain table reads, not website scrapes.
 *
 * Defibox WAX: contract swap.box, table `pairs` (token0/token1 + reserve0/reserve1).
 * Fee: trade 20 + protocol 10 = 30 (0.30%) per defibox.hpp. Memo:
 *   swap,<min_out_integer>,<pair_id>
 *
 * TacoSwap: contract swap.taco. Observed live memo:
 *   <minOutAmount> <SYMBOL>@<contract>
 * Pools table is tried as `pairs` then `pools`. Fee documented as 0.30%
 * (3000 Alcor units) for unstaked swaps.
 */
import { rpcPost } from "@/lib/wallet/chain";
import {
  DEFIBOX_ID_BASE,
  DEFIBOX_SWAP,
  TACO_ID_BASE,
  TACO_SWAP,
  parseAssetQty,
  parseEosSymbol,
  tokenOk,
  tvlFromWax,
  waxQty,
  type VenuePool,
  type VenueToken,
} from "./venues";

type TableRow = Record<string, unknown>;

/**
 * Bounded-concurrency worker pool (waxterminal sharded-sweep lesson): run
 * `fn` over every item with at most `maxInFlight` promises live at once.
 * Order of results matches the input order. The per-host queue inside
 * fetchJson stays the real network throttle — this bounds how much work we
 * even hand it.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  maxInFlight: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(maxInFlight, items.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

/** Venue sweep fan-out: shards per table sweep, at most this many in flight. */
export const SWEEP_CONCURRENCY = 4;
/** Pair ids beyond this are still covered — the last shard is open-ended. */
const SWEEP_SHARD_SPAN = 25_000;
/** Per-shard page cap (same 8-page ceiling as the old sequential sweep). */
const SWEEP_MAX_PAGES = 8;

type TableRowsPage = { rows?: TableRow[]; more?: boolean; next_key?: string };

async function readTablePage(
  code: string,
  table: string,
  limit: number,
  lowerBound: string | number,
  upperBound?: number,
): Promise<TableRowsPage> {
  return (await rpcPost("/v1/chain/get_table_rows", {
    json: true,
    code,
    scope: code,
    table,
    limit,
    lower_bound: lowerBound,
    ...(upperBound != null ? { upper_bound: upperBound } : {}),
  })) as TableRowsPage;
}

function rowKey(row: TableRow): string {
  const id = row.id ?? row.pool_id ?? row.poolid;
  return id != null ? String(id) : JSON.stringify(row);
}

/** Numeric primary key, when the row carries one (all venue pair tables do). */
function rowNumericId(row: TableRow): number | null {
  const id = Number(row.id ?? row.pool_id ?? row.poolid);
  return Number.isFinite(id) ? id : null;
}

/**
 * Sharded table sweep. Instead of 8 strictly sequential pages, the primary-
 * key space is split into shards paged in parallel by a small worker pool
 * (max SWEEP_CONCURRENCY in flight). The final shard is open-ended so a pair
 * id beyond the fixed span is never missed. Rows outside a shard's bounds
 * (a key landing mid-page) are dropped and duplicates removed by key.
 */
async function getTableRows(code: string, table: string, limit = 200): Promise<TableRow[]> {
  const shards: { lower: number; upper: number | null }[] = [];
  for (let i = 0; i < SWEEP_CONCURRENCY; i++) {
    shards.push({
      lower: i * SWEEP_SHARD_SPAN,
      upper: i === SWEEP_CONCURRENCY - 1 ? null : (i + 1) * SWEEP_SHARD_SPAN - 1,
    });
  }
  const perShard = await mapPool(shards, SWEEP_CONCURRENCY, async (shard) => {
    const rows: TableRow[] = [];
    let lowerBound: string | number = shard.lower;
    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      const raw = await readTablePage(code, table, limit, lowerBound, shard.upper ?? undefined);
      const chunk = Array.isArray(raw.rows) ? raw.rows : [];
      rows.push(...chunk);
      if (!raw.more || chunk.length === 0) break;
      const lastId = rowNumericId(chunk[chunk.length - 1]!);
      const next = raw.next_key ?? (lastId != null ? lastId + 1 : rows.length);
      if (shard.upper != null && Number(next) > shard.upper) break;
      lowerBound = next;
    }
    return rows;
  });
  const seen = new Set<string>();
  const out: TableRow[] = [];
  for (let s = 0; s < perShard.length; s++) {
    const shard = shards[s]!;
    for (const row of perShard[s]!) {
      const id = rowNumericId(row);
      // A shard owns only rows inside its bounds; strays are fetched (or
      // deduped away) by the shard that owns them.
      if (id != null && (id < shard.lower || (shard.upper != null && id > shard.upper))) {
        continue;
      }
      const key = rowKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

function tokenFromDefibox(raw: unknown, reserve: unknown): VenueToken | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { contract?: unknown; symbol?: unknown };
  const contract = String(o.contract ?? "");
  const parsed = parseEosSymbol(o.symbol);
  const qty = parseAssetQty(reserve);
  if (!parsed || !contract) return null;
  return {
    symbol: parsed.symbol,
    contract,
    decimals: parsed.decimals,
    quantity: qty && qty.symbol === parsed.symbol ? qty.amount : 0,
  };
}

/** Defibox fee units in Alcor scale: 30 bps → 3000. */
export const DEFIBOX_FEE_ALCOR = 3000;
export const TACO_FEE_ALCOR = 3000;

export function parseDefiboxPairs(rows: TableRow[], waxUsd: number): VenuePool[] {
  const out: VenuePool[] = [];
  for (const r of rows) {
    const nativeId = Number(r.id);
    if (!Number.isFinite(nativeId)) continue;
    const a = tokenFromDefibox(r.token0, r.reserve0);
    const b = tokenFromDefibox(r.token1, r.reserve1);
    if (!a || !b || !tokenOk(a) || !tokenOk(b)) continue;
    if (!(a.quantity > 0) || !(b.quantity > 0)) continue;
    const pool: VenuePool = {
      venue: "defibox",
      id: DEFIBOX_ID_BASE + nativeId,
      nativeId,
      tokenA: a,
      tokenB: b,
      fee: DEFIBOX_FEE_ALCOR,
      feePct: 0.3,
      tvlUsd: 0,
    };
    pool.tvlUsd = tvlFromWax(waxQty(pool), waxUsd);
    if (pool.tvlUsd < 5 && waxQty(pool) < 50) continue;
    out.push(pool);
  }
  return out;
}

function tacoToken(raw: unknown, fallbackQty?: unknown): VenueToken | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as {
    contract?: unknown;
    quantity?: unknown;
    symbol?: unknown;
  };
  const contract = String(o.contract ?? "");
  const qty = parseAssetQty(o.quantity ?? fallbackQty);
  const parsed = parseEosSymbol(o.symbol) ?? (qty ? { symbol: qty.symbol, decimals: 4 } : null);
  if (!parsed || !contract) return null;
  return {
    symbol: parsed.symbol,
    contract,
    decimals: parsed.decimals,
    quantity: qty?.amount ?? 0,
  };
}

export function parseTacoPairs(rows: TableRow[], waxUsd: number): VenuePool[] {
  const out: VenuePool[] = [];
  for (const r of rows) {
    const nativeId = Number(r.id ?? r.pool_id ?? r.poolid);
    if (!Number.isFinite(nativeId)) continue;
    const a =
      tacoToken(r.token0, r.reserve0) ??
      tacoToken(r.pool1) ??
      tacoToken(r.quantity_a);
    const b =
      tacoToken(r.token1, r.reserve1) ??
      tacoToken(r.pool2) ??
      tacoToken(r.quantity_b);
    if (!a || !b || !tokenOk(a) || !tokenOk(b)) continue;
    if (!(a.quantity > 0) || !(b.quantity > 0)) continue;
    const pool: VenuePool = {
      venue: "taco",
      id: TACO_ID_BASE + nativeId,
      nativeId,
      tokenA: a,
      tokenB: b,
      fee: TACO_FEE_ALCOR,
      feePct: 0.3,
      tvlUsd: 0,
    };
    pool.tvlUsd = tvlFromWax(waxQty(pool), waxUsd);
    if (pool.tvlUsd < 5 && waxQty(pool) < 50) continue;
    out.push(pool);
  }
  return out;
}

export async function fetchDefiboxPools(waxUsd: number): Promise<VenuePool[]> {
  try {
    const rows = await getTableRows(DEFIBOX_SWAP, "pairs", 200);
    return parseDefiboxPairs(rows, waxUsd);
  } catch {
    return [];
  }
}

export async function fetchTacoPools(waxUsd: number): Promise<VenuePool[]> {
  try {
    let rows = await getTableRows(TACO_SWAP, "pairs", 200);
    if (rows.length === 0) rows = await getTableRows(TACO_SWAP, "pools", 200);
    return parseTacoPairs(rows, waxUsd);
  } catch {
    return [];
  }
}

let venueCache: { at: number; waxUsd: number; pools: VenuePool[] } | null = null;
const VENUE_TTL_MS = 120_000;

export async function fetchExternalVenues(waxUsd: number): Promise<VenuePool[]> {
  if (venueCache && Date.now() - venueCache.at < VENUE_TTL_MS) return venueCache.pools;
  const [d, t] = await Promise.all([fetchDefiboxPools(waxUsd), fetchTacoPools(waxUsd)]);
  const pools = [...d, ...t];
  venueCache = { at: Date.now(), waxUsd, pools };
  return pools;
}

/**
 * Fresh on-chain pair row for one Defibox/Taco pool. Topology cache (120s)
 * is NOT executable truth — live legs re-read the table row.
 */
export async function refreshVenuePair(
  venue: "defibox" | "taco",
  nativeId: number,
  waxUsd: number,
): Promise<VenuePool | null> {
  try {
    if (venue === "defibox") {
      const raw = (await rpcPost(
        "/v1/chain/get_table_rows",
        {
          json: true,
          code: DEFIBOX_SWAP,
          scope: DEFIBOX_SWAP,
          table: "pairs",
          lower_bound: nativeId,
          upper_bound: nativeId,
          limit: 1,
        },
        4_000,
        "high",
      )) as { rows?: TableRow[] };
      const parsed = parseDefiboxPairs(raw.rows ?? [], waxUsd);
      return parsed.find((p) => p.nativeId === nativeId) ?? parsed[0] ?? null;
    }
    let raw = (await rpcPost(
      "/v1/chain/get_table_rows",
      {
        json: true,
        code: TACO_SWAP,
        scope: TACO_SWAP,
        table: "pairs",
        lower_bound: nativeId,
        upper_bound: nativeId,
        limit: 1,
      },
        4_000,
        "high",
      )) as { rows?: TableRow[] };
    if (!raw.rows?.length) {
      raw = (await rpcPost(
        "/v1/chain/get_table_rows",
        {
          json: true,
          code: TACO_SWAP,
          scope: TACO_SWAP,
          table: "pools",
          lower_bound: nativeId,
          upper_bound: nativeId,
          limit: 1,
        },
        4_000,
        "high",
      )) as { rows?: TableRow[] };
    }
    const parsed = parseTacoPairs(raw.rows ?? [], waxUsd);
    return parsed.find((p) => p.nativeId === nativeId) ?? parsed[0] ?? null;
  } catch {
    return null;
  }
}

/** Defibox memo: swap,<min_out as integer units>,<pair_id> */
export function defiboxMemo(minOut: number, decimals: number, pairId: number): string {
  // Truncate toward zero (never demand more than quoted) — +1e-9 absorbs
  // IEEE-754 dust (12.3456 * 1e4 is 123455.999…), same as tacoMemo/formatAsset.
  const units = Math.max(0, Math.floor(minOut * 10 ** decimals + 1e-9));
  return `swap,${units},${pairId}`;
}

/** Taco memo observed on-chain: `<min> <SYM>@<contract>`. Truncates toward
 * zero — rounding up would demand more than the pool can pay and revert. */
export function tacoMemo(minOut: number, symbol: string, contract: string, decimals: number): string {
  const d = Math.max(0, Math.min(18, decimals | 0));
  const scale = 10 ** d;
  const units = Math.floor(Math.max(0, minOut) * scale + 1e-9);
  const whole = Math.floor(units / scale);
  const frac = units % scale;
  const body = d === 0 ? String(whole) : `${whole}.${String(frac).padStart(d, "0")}`;
  return `${body} ${symbol}@${contract}`;
}
