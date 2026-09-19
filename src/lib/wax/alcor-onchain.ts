/**
 * Direct on-chain Alcor pool state — the chain-truth layer.
 *
 * Mirrors the pattern from Alcor's own v2 SDK (`@alcorexchange/alcor-swap-sdk`):
 * read the `swap.alcor` `pools` table straight from WAX RPC and build pool
 * state from `currSlot.sqrtPriceX64` / `currSlot.tick`, instead of trusting
 * the website API as the only source.
 *
 *   WAX RPC → swap.alcor pools table → local pool state → route math
 *
 * The Alcor HTTP API remains the convenience/discovery layer; the router
 * remains the executable-quote layer. This module is what lets prices move
 * BETWEEN API pulls — straight from the chain, block by block.
 */
import { q64Price } from "@/lib/leef/amm";
import type { AuxPool, LeefPool } from "@/lib/leef/types";
import { isLeefToken } from "@/lib/leef/amm";
import { rpcPool } from "./provider-pool";

export const ALCOR_SWAP = "swap.alcor";

export type OnchainToken = {
  symbol: string;
  contract: string;
  decimals: number;
  quantity: number;
};

export type OnchainPool = {
  id: number;
  active: boolean;
  fee: number;
  tickSpacing: number;
  liquidity: string;
  sqrtPriceX64: string;
  tick: number;
  tokenA: OnchainToken;
  tokenB: OnchainToken;
  /** Whole tokenA in tokenB at the on-chain sqrt price. */
  priceAInB: number | null;
};

type RawRow = {
  id?: number;
  active?: number | boolean;
  fee?: number;
  tickSpacing?: number;
  liquidity?: string;
  currSlot?: { sqrtPriceX64?: string; tick?: number };
  tokenA?: { quantity?: string; contract?: string };
  tokenB?: { quantity?: string; contract?: string };
};

/** "13257.13064633 WAX" → { quantity, symbol, decimals } (precision from the string). */
function parseOnchainAsset(raw: unknown): OnchainToken | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d+)(?:\.(\d+))? ([A-Z]{1,7})$/);
  if (!m) return null;
  const frac = m[2] ?? "";
  return {
    symbol: m[3]!,
    contract: "",
    decimals: frac.length,
    quantity: Number(`${m[1]!}.${frac || "0"}`),
  };
}

export function parseOnchainPool(row: RawRow): OnchainPool | null {
  const id = Number(row.id);
  if (!Number.isFinite(id)) return null;
  const aRaw = row.tokenA;
  const bRaw = row.tokenB;
  if (!aRaw || !bRaw) return null;
  const a = parseOnchainAsset(aRaw.quantity);
  const b = parseOnchainAsset(bRaw.quantity);
  if (!a || !b) return null;
  const curr = row.currSlot ?? {};
  const sqrtPriceX64 =
    typeof curr.sqrtPriceX64 === "string" && curr.sqrtPriceX64.length > 0
      ? curr.sqrtPriceX64
      : "0";
  const priceAInB = q64Price(sqrtPriceX64 || undefined, a.decimals, b.decimals);
  return {
    id,
    active: row.active !== false && row.active !== 0,
    fee: Number(row.fee) || 3000,
    tickSpacing: Number(row.tickSpacing) || 60,
    liquidity: String(row.liquidity ?? "0"),
    sqrtPriceX64,
    tick: Number(curr.tick ?? 0),
    tokenA: { ...a, contract: String(aRaw.contract ?? "") },
    tokenB: { ...b, contract: String(bRaw.contract ?? "") },
    priceAInB,
  };
}

type TableRowsResponse = { rows?: RawRow[]; more?: boolean; next_key?: string };

async function readRange(lower: number, upper: number): Promise<OnchainPool[]> {
  const raw = (await rpcPool.call(
    "/v1/chain/get_table_rows",
    {
      json: true,
      code: ALCOR_SWAP,
      scope: ALCOR_SWAP,
      table: "pools",
      lower_bound: lower,
      upper_bound: upper,
      limit: Math.max(1, upper - lower + 1),
    },
    { timeoutMs: 8_000, priority: "high" },
  )) as TableRowsResponse;
  const rows = Array.isArray(raw?.rows) ? raw.rows : [];
  const out: OnchainPool[] = [];
  for (const r of rows) {
    const p = parseOnchainPool(r);
    if (p) out.push(p);
  }
  return out;
}

/** Split wanted ids into contiguous-ish ranges so each read stays small. */
export function idRanges(ids: number[], maxGap = 8): { lower: number; upper: number }[] {
  const sorted = [...new Set(ids)].filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const ranges: { lower: number; upper: number }[] = [];
  let start = sorted[0]!;
  let prev = start;
  for (const id of sorted.slice(1)) {
    if (id - prev > maxGap) {
      ranges.push({ lower: start, upper: prev });
      start = id;
    }
    prev = id;
  }
  ranges.push({ lower: start, upper: prev });
  return ranges;
}

/**
 * Fresh on-chain state for the given Alcor pool ids. One small table read per
 * contiguous id cluster — NOT a website API call. Returns only the ids asked
 * for (id is the primary key, rows are exact).
 */
export async function fetchOnchainPools(ids: number[]): Promise<Map<number, OnchainPool>> {
  const out = new Map<number, OnchainPool>();
  if (ids.length === 0) return out;
  const wanted = new Set(ids);
  const ranges = idRanges(ids);
  const results = await Promise.allSettled(ranges.map((r) => readRange(r.lower, r.upper)));
  for (const res of results) {
    if (res.status !== "fulfilled") continue;
    for (const p of res.value) {
      if (wanted.has(p.id)) out.set(p.id, p);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* merging chain truth into the local pool model                        */
/* ------------------------------------------------------------------ */

/**
 * Patch a LeefPool (from the Alcor API) with fresher on-chain state.
 * Returns null when the row is gone/inactive (pool delisted) or the on-chain
 * price is unusable. Reserves are ALSO refreshed (quantity strings carry
 * them), so constant-product math stays honest too.
 */
export function applyOnchainToLeefPool(pool: LeefPool, oc: OnchainPool): LeefPool | null {
  if (!oc.active) return null;
  const leefIsA = isLeefToken(oc.tokenA);
  const leefIsB = isLeefToken(oc.tokenB);
  if (!leefIsA && !leefIsB) return null;

  const pairPerLeefFromSqrt =
    leefIsA && oc.priceAInB
      ? oc.priceAInB // A=LEEF: A-in-B price is B per LEEF
      : leefIsB && oc.priceAInB && oc.priceAInB > 0
        ? 1 / oc.priceAInB // B=LEEF: invert A-in-B
        : null;
  // Reserves: pair per LEEF (direction depends on which side LEEF sits).
  const fromReserves =
    leefIsA
      ? oc.tokenA.quantity > 0
        ? oc.tokenB.quantity / oc.tokenA.quantity
        : 0
      : oc.tokenB.quantity > 0
        ? oc.tokenA.quantity / oc.tokenB.quantity
        : 0;
  const pairPerLeef =
    pairPerLeefFromSqrt && pairPerLeefFromSqrt > 0 && pairPerLeefFromSqrt < fromReserves * 1e4
      ? pairPerLeefFromSqrt
      : fromReserves > 0
        ? fromReserves
        : (pairPerLeefFromSqrt ?? pool.pairPerLeef);
  if (!(pairPerLeef > 0)) return null;

  const leefTok = leefIsA ? oc.tokenA : oc.tokenB;
  const pairTok = leefIsA ? oc.tokenB : oc.tokenA;
  return {
    ...pool,
    leef: { ...pool.leef, quantity: leefTok.quantity, decimals: leefTok.decimals },
    pair: { ...pool.pair, quantity: pairTok.quantity, decimals: pairTok.decimals },
    liquidity: oc.liquidity,
    sqrtPriceX64: oc.sqrtPriceX64,
    pairPerLeef,
    leefPerPair: pairPerLeef > 0 ? 1 / pairPerLeef : 0,
    // For non-WAX pairs the pair→WAX conversion is recomputed by
    // attachUsdPrices from the aux book — keep the previous value here.
    waxPerLeef:
      pool.pair.symbol.toUpperCase() === "WAX" ? pairPerLeef : (pool.waxPerLeef ?? null),
  };
}

/** Patch an AuxPool (WAX-quoted helpers) with on-chain state. */
export function applyOnchainToAuxPool(pool: AuxPool, oc: OnchainPool): AuxPool | null {
  if (!oc.active) return null;
  const priceAInB =
    oc.priceAInB ?? (oc.tokenB.quantity > 0 ? oc.tokenA.quantity / oc.tokenB.quantity : 0);
  if (!(priceAInB > 0)) return null;
  return {
    ...pool,
    tokenA: { ...pool.tokenA, quantity: oc.tokenA.quantity, decimals: oc.tokenA.decimals },
    tokenB: { ...pool.tokenB, quantity: oc.tokenB.quantity, decimals: oc.tokenB.decimals },
    // Thread the chain-truth spot price through — otherwise the patch
    // updates quantities while the price silently stays at the API pull.
    priceA: priceAInB,
    priceB: 1 / priceAInB,
    sqrtPriceX64: oc.sqrtPriceX64,
    liquidity: oc.liquidity,
  };
}

/** Did the on-chain row meaningfully change vs the local pool copy? */
export function onchainDiffers(
  local: {
    sqrtPriceX64?: string;
    liquidity: string;
    qtyA: number;
    qtyB: number;
  },
  oc: OnchainPool,
): boolean {
  if ((local.sqrtPriceX64 ?? "0") !== oc.sqrtPriceX64) return true;
  if (local.liquidity !== oc.liquidity) return true;
  if (Math.abs(local.qtyA - oc.tokenA.quantity) > 1e-6) return true;
  if (Math.abs(local.qtyB - oc.tokenB.quantity) > 1e-6) return true;
  return false;
}
