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
 *
 * NeftyBlocks: contract swap.nefty, table `pairs` keyed by symbol_code
 * (`code`, e.g. "USDANO") with extended_asset reserve0/reserve1. Verified
 * live 2026-09-23: memo `swap:<CODE>,min:<rawUnits>` (WaxOnEdge omits `,min:`
 * — a zero floor; the C1 hardening forbids that here, so the min is mandatory
 * and > 0). Fee from the `configs` singleton: fee.protocol (10 bp, skimmed
 * inline to sfees.nefty) + fee.trade (20 bp) = 30 bp = 0.30%. Constant-product
 * verified against executed logswap traces (out = (in−fee)·r1/(r0+in−fee)).
 * Reverse-engineered schema — discovery fails CLOSED (log + skip) on any
 * shape surprise, and the venue sits behind a persisted kill-switch.
 */
import { rpcPost } from "@/lib/wallet/chain";
import {
  DEFIBOX_ID_BASE,
  DEFIBOX_SWAP,
  NEFTY_ID_BASE,
  NEFTY_SWAP,
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

/* ------------------------------------------------------------------ */
/* NeftyBlocks (swap.nefty) — reverse-engineered, fail closed          */
/* ------------------------------------------------------------------ */

/**
 * Nefty fee in Alcor units: 3000 = 0.30%. Live `configs` row 2026-09-23:
 * fee.protocol = 10 bp (skimmed inline to sfees.nefty) + fee.trade = 20 bp.
 * Cross-checked against executed logswap fees (e.g. 2.09944290 BANKSY on
 * 699.81430149 in = exactly 0.3%).
 */
export const NEFTY_FEE_ALCOR = 3000;

/** Pair code shape: EOSIO symbol_code — 1–7 uppercase alnum chars. */
const NEFTY_CODE_RE = /^[A-Z0-9]{1,7}$/;
/** Page cap for the code-keyed pairs sweep (756 pairs live = 4 pages @200). */
const NEFTY_MAX_PAGES = 12;

/**
 * Stable numeric handle for a Nefty pair code: 32-bit FNV-1a. The on-chain
 * key is the symbol_code string itself (no numeric id), so the namespaced
 * route-graph id is NEFTY_ID_BASE + hash(code). Collision handling is in
 * parseNeftyPairs (first code wins, the other is logged and skipped).
 */
export function neftyPairNativeId(code: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** extended_asset → VenueToken; null on any shape surprise. */
function neftyToken(raw: unknown): VenueToken | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { quantity?: unknown; contract?: unknown };
  const contract = String(o.contract ?? "");
  const qty = parseAssetQty(o.quantity);
  if (!qty || !contract) return null;
  const frac = String(o.quantity ?? "").trim().split(/\s+/)[0]?.split(".")[1] ?? "";
  return { symbol: qty.symbol, contract, decimals: frac.length, quantity: qty.amount };
}

function neftyWarn(msg: string, row: TableRow): void {
  // Fail CLOSED on schema surprises: log + skip the pool, never throw into
  // the engine loop. This venue's schema is reverse-engineered.
  console.warn(`[nefty] skipping pair row: ${msg}`, JSON.stringify(row).slice(0, 200));
}

export function parseNeftyPairs(
  rows: TableRow[],
  waxUsd: number,
  feeAlcor: number = NEFTY_FEE_ALCOR,
): VenuePool[] {
  const out: VenuePool[] = [];
  const codeByHash = new Map<number, string>();
  const parsedCodes = new Set<string>();
  for (const r of rows) {
    const code = typeof r.code === "string" ? r.code : "";
    if (!NEFTY_CODE_RE.test(code)) {
      neftyWarn("bad/missing pair code", r);
      continue;
    }
    if (parsedCodes.has(code)) continue; // node returned the row twice
    parsedCodes.add(code);
    // Inactive pairs are a normal state — skip silently.
    if (!(r.active === true || r.active === 1)) continue;
    const a = neftyToken(r.reserve0);
    const b = neftyToken(r.reserve1);
    if (!a || !b) {
      neftyWarn("unparseable reserves", r);
      continue;
    }
    if (!tokenOk(a) || !tokenOk(b) || a.symbol === b.symbol) {
      neftyWarn("token identity failed verification", r);
      continue;
    }
    if (!(a.quantity > 0) || !(b.quantity > 0)) continue; // drained pool
    const nativeId = neftyPairNativeId(code);
    const seen = codeByHash.get(nativeId);
    if (seen != null && seen !== code) {
      neftyWarn(`pair-code hash collision with ${seen}`, r);
      continue;
    }
    codeByHash.set(nativeId, code);
    const pool: VenuePool = {
      venue: "nefty",
      id: NEFTY_ID_BASE + nativeId,
      nativeId,
      pairCode: code,
      tokenA: a,
      tokenB: b,
      fee: feeAlcor,
      feePct: feeAlcor / 10_000,
      tvlUsd: 0,
    };
    pool.tvlUsd = tvlFromWax(waxQty(pool), waxUsd);
    if (pool.tvlUsd < 5 && waxQty(pool) < 50) continue;
    out.push(pool);
  }
  return out;
}

/** Live fee from the `configs` singleton; NEFTY_FEE_ALCOR on any surprise. */
async function fetchNeftyFeeAlcor(): Promise<number> {
  try {
    const raw = await readTablePage(NEFTY_SWAP, "configs", 20, "");
    const rows = Array.isArray(raw.rows) ? raw.rows : [];
    let trade = NaN;
    let protocol = NaN;
    for (const r of rows) {
      const v = Number(r.value);
      if (r.key === "fee.trade") trade = v;
      if (r.key === "fee.protocol") protocol = v;
    }
    const bp = trade + protocol;
    // Sanity bound: a total fee above 1% means the schema moved under us.
    if (!Number.isFinite(bp) || bp < 0 || bp > 100) return NEFTY_FEE_ALCOR;
    return Math.round(bp * 100); // bp → Alcor units (30 bp → 3000)
  } catch {
    return NEFTY_FEE_ALCOR;
  }
}

let neftyFeeCache: { at: number; fee: number } | null = null;
const NEFTY_FEE_TTL_MS = 600_000;

async function neftyFeeAlcorCached(): Promise<number> {
  if (neftyFeeCache && Date.now() - neftyFeeCache.at < NEFTY_FEE_TTL_MS) {
    return neftyFeeCache.fee;
  }
  const fee = await fetchNeftyFeeAlcor();
  neftyFeeCache = { at: Date.now(), fee };
  return fee;
}

/**
 * Pairs sweep keyed by symbol_code: the numeric sharded sweep does not apply
 * (keys are sparse 56-bit code values), so page by next_key with a hard page
 * cap. Any malformed page ends the sweep — partial books are better than
 * trusting a schema that moved.
 */
async function getNeftyPairRows(limit = 200): Promise<TableRow[]> {
  const rows: TableRow[] = [];
  const seen = new Set<string>();
  let lowerBound: string | number = 0;
  for (let page = 0; page < NEFTY_MAX_PAGES; page++) {
    const raw = await readTablePage(NEFTY_SWAP, "pairs", limit, lowerBound);
    const chunk = Array.isArray(raw.rows) ? raw.rows : [];
    for (const row of chunk) {
      const key = typeof row.code === "string" ? row.code : JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    if (!raw.more || chunk.length === 0) break;
    const next = raw.next_key;
    if (next == null || String(next) === String(lowerBound)) break;
    lowerBound = String(next);
  }
  return rows;
}

export async function fetchNeftyPools(waxUsd: number): Promise<VenuePool[]> {
  try {
    const [fee, rows] = await Promise.all([neftyFeeAlcorCached(), getNeftyPairRows()]);
    return parseNeftyPairs(rows, waxUsd, fee);
  } catch {
    return [];
  }
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

/* ------------------------------------------------------------------ */
/* Nefty kill-switch (persisted setting lives in store/bot.ts)         */
/* ------------------------------------------------------------------ */

/**
 * Default ON. The Nefty table schema is reverse-engineered, so a persisted
 * kill-switch must be able to pull the venue out of the route graph without a
 * redeploy. store/bot.ts keeps this in sync with the persisted setting.
 */
let neftyVenueEnabled = true;

export function setNeftyVenueEnabled(on: boolean): void {
  neftyVenueEnabled = on === true;
}

export function neftyVenueEnabledNow(): boolean {
  return neftyVenueEnabled;
}

let venueCache: { at: number; waxUsd: number; nefty: boolean; pools: VenuePool[] } | null = null;
const VENUE_TTL_MS = 120_000;

export async function fetchExternalVenues(waxUsd: number): Promise<VenuePool[]> {
  if (
    venueCache &&
    venueCache.nefty === neftyVenueEnabled &&
    Date.now() - venueCache.at < VENUE_TTL_MS
  ) {
    return venueCache.pools;
  }
  const [d, t, n] = await Promise.all([
    fetchDefiboxPools(waxUsd),
    fetchTacoPools(waxUsd),
    neftyVenueEnabled ? fetchNeftyPools(waxUsd) : Promise.resolve([]),
  ]);
  const pools = [...d, ...t, ...n];
  venueCache = { at: Date.now(), waxUsd, nefty: neftyVenueEnabled, pools };
  return pools;
}

/**
 * Fresh on-chain pair row for one Defibox/Taco pool. Topology cache (120s)
 * is NOT executable truth — live legs re-read the table row.
 */
export async function refreshVenuePair(
  venue: "defibox" | "taco" | "nefty",
  nativeId: number,
  waxUsd: number,
  /** Nefty only: the on-chain pair code (its table is keyed by code, not id). */
  pairCode?: string,
): Promise<VenuePool | null> {
  try {
    if (venue === "nefty") {
      // Fail closed: no code (or a malformed one) → no fresh quote.
      if (!pairCode || !NEFTY_CODE_RE.test(pairCode)) return null;
      const raw = (await rpcPost(
        "/v1/chain/get_table_rows",
        {
          json: true,
          code: NEFTY_SWAP,
          scope: NEFTY_SWAP,
          table: "pairs",
          lower_bound: pairCode,
          upper_bound: pairCode,
          limit: 1,
        },
        4_000,
        "high",
      )) as { rows?: TableRow[] };
      const fee = await neftyFeeAlcorCached();
      const parsed = parseNeftyPairs(raw.rows ?? [], waxUsd, fee);
      // Exact code match only — a neighboring row is a schema surprise.
      return parsed.find((p) => p.pairCode === pairCode) ?? null;
    }
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

/**
 * Nefty memo, verified live 2026-09-23: `swap:<CODE>,min:<units>` where
 * `units` is the min-out as an INTEGER count of raw output-token units
 * (confirmed by traces: `min:137` passed on a 19.82-token output, i.e. raw
 * units, not whole tokens). WaxOnEdge sends `swap:<CODE>` with no min — a
 * zero floor the C1 hardening forbids here. Truncates toward zero, floor of
 * 1 unit (a zero min-out is no on-chain guarantee).
 */
export function neftyMemo(minOut: number, decimals: number, pairCode: string): string {
  const d = Math.max(0, Math.min(18, decimals | 0));
  const units = Math.max(1, Math.floor(Math.max(0, minOut) * 10 ** d + 1e-9));
  return `swap:${pairCode},min:${units}`;
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
