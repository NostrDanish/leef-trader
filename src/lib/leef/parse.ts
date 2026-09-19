import { feeToPct, isLeefToken, isWaxToken, q64Price } from "./amm";
import type { AuxPool, LeefPool, LiveTrade, TokenRef } from "./types";
import { isTrustedStable } from "@/lib/market/stables";

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function tokenFrom(raw: Record<string, unknown> | undefined): TokenRef | null {
  if (!raw) return null;
  const symbol = String(raw.symbol ?? "").toUpperCase();
  const contract = String(raw.contract ?? "");
  if (!symbol) return null;
  const decimals = Number(raw.decimals ?? 4);
  const quantity = num(raw.quantity);
  return { symbol, contract, decimals, quantity };
}

type RawPool = Record<string, unknown> & {
  tokenA?: Record<string, unknown>;
  tokenB?: Record<string, unknown>;
};

export function parseTokenRef(raw: unknown): TokenRef | null {
  if (!raw || typeof raw !== "object") return null;
  return tokenFrom(raw as Record<string, unknown>);
}

export function parseAllPools(raw: unknown): { leef: LeefPool[]; aux: AuxPool[] } {
  const list = Array.isArray(raw) ? (raw as RawPool[]) : [];
  const leef: LeefPool[] = [];
  const aux: AuxPool[] = [];

  for (const p of list) {
    const a = tokenFrom(p.tokenA);
    const b = tokenFrom(p.tokenB);
    if (!a || !b) continue;
    const id = Number(p.id);
    if (!Number.isFinite(id)) continue;
    const fee = num(p.fee) || 3000;
    const tvlUsd = num(p.tvlUSD ?? p.tvlUsd);
    const volume24Usd = num(
      p.volumeUSD24 ?? p.volume24USD ?? p.volumeUsd24 ?? p.volume24Usd,
    );
    const volumeWeekUsd = num(p.volumeUSDWeek ?? p.volumeWeekUSD);
    const volumeUsdMonth = num(p.volumeUSDMonth ?? p.volumeMonthUSD);
    const volumeUsd90 = num(p.volumeUSD90 ?? p.volume90USD);
    const volumeA24 = num(p.volumeA24);
    const volumeB24 = num(p.volumeB24);
    const sqrt = p.sqrtPriceX64 != null ? String(p.sqrtPriceX64) : undefined;
    const firstSeenAt = p.firstSeenAt ? String(p.firstSeenAt) : undefined;
    const tickSpacingRaw = num(p.tickSpacing);

    const leefIsA = isLeefToken(a);
    const leefIsB = isLeefToken(b);
    if (leefIsA || leefIsB) {
      const leefTok = leefIsA ? a : b;
      const pairTok = leefIsA ? b : a;
      if (leefTok.quantity <= 1 && pairTok.quantity <= 0) continue;
      const pxFromSqrt = q64Price(
        sqrt,
        leefIsA ? a.decimals : b.decimals,
        leefIsA ? b.decimals : a.decimals,
      );
      const priceA = num(p.priceA);
      const priceB = num(p.priceB);
      const fromApi = leefIsA ? priceA : priceB;
      const fromSqrt =
        pxFromSqrt && leefIsA
          ? pxFromSqrt
          : pxFromSqrt && leefIsB
            ? pxFromSqrt > 0
              ? 1 / pxFromSqrt
              : 0
            : 0;
      const fromReserves =
        leefTok.quantity > 0 ? pairTok.quantity / leefTok.quantity : 0;
      // Prefer Alcor's quoted price (handles concentrated liquidity).
      const pairPerLeef =
        fromApi > 0 && fromApi < fromReserves * 1e4
          ? fromApi
          : fromSqrt > 0 && fromReserves > 0 && fromSqrt < fromReserves * 1e4
            ? fromSqrt
            : fromReserves;
      leef.push({
        id,
        fee,
        feePct: feeToPct(fee),
        leef: leefTok,
        pair: pairTok,
        leefIsA,
        tvlUsd,
        volume24Usd,
        volumeWeekUsd,
        volumeUsdMonth,
        volumeUsd90,
        volumeLeef24: leefIsA ? volumeA24 : volumeB24,
        volumePair24: leefIsA ? volumeB24 : volumeA24,
        change24: num(p.change24),
        changeWeek: num(p.changeWeek),
        liquidity: String(p.liquidity ?? "0"),
        pairPerLeef,
        leefPerPair: pairPerLeef > 0 ? 1 / pairPerLeef : 0,
        waxPerLeef: isWaxToken(pairTok) ? pairPerLeef : null,
        usdPerLeef: null,
        firstSeenAt,
        sqrtPriceX64: sqrt,
        tickSpacing:
          tickSpacingRaw > 0
            ? tickSpacingRaw
            : fee >= 10000
              ? 200
              : fee >= 3000
                ? 60
                : 10,
      });
      continue;
    }

    aux.push({
      id,
      fee,
      feePct: feeToPct(fee),
      tokenA: a,
      tokenB: b,
      tvlUsd,
      volume24Usd,
      // Spot prices from the API: CLMM pools' raw reserves are NOT the spot
      // price (concentrated liquidity skews holdings). attachUsdPrices
      // prefers these over the reserve ratio.
      priceA: num(p.priceA) > 0 ? num(p.priceA) : undefined,
      priceB: num(p.priceB) > 0 ? num(p.priceB) : undefined,
      sqrtPriceX64: sqrt,
    });
  }

  return { leef, aux };
}

/* ------------------------------------------------------------------ */
/* Last-known WAX price (persisted)                                     */
/* ------------------------------------------------------------------ */

const LAST_WAX_KEY = "leef-last-wax-usd-v2";
let lastKnownWaxUsdCache = 0;
let lastKnownWaxAtCache = 0;

function hydrateLastKnown(): void {
  if (lastKnownWaxUsdCache > 0) return;
  try {
    const raw = globalThis.localStorage?.getItem(LAST_WAX_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { usd?: number; at?: number };
    if (parsed && typeof parsed.usd === "number" && parsed.usd > 0) {
      lastKnownWaxUsdCache = parsed.usd;
      lastKnownWaxAtCache = typeof parsed.at === "number" ? parsed.at : 0;
    }
  } catch {
    /* storage unavailable or legacy value */
  }
}

/**
 * Last KNOWN live price with its observation time. 0 when never seen.
 * A number without provenance is not a price — the timestamp is what makes
 * "last known" honest.
 */
export function lastKnownWaxUsd(): { usd: number; at: number } {
  hydrateLastKnown();
  return { usd: lastKnownWaxUsdCache, at: lastKnownWaxAtCache };
}

/** Record a freshly computed live WAX price. Never stores hints/fallbacks. */
export function noteKnownWaxUsd(usd: number): void {
  if (!(usd > 0) || !Number.isFinite(usd)) return;
  lastKnownWaxUsdCache = usd;
  lastKnownWaxAtCache = Date.now();
  try {
    globalThis.localStorage?.setItem(
      LAST_WAX_KEY,
      JSON.stringify({ usd, at: lastKnownWaxAtCache }),
    );
  } catch {
    /* storage unavailable */
  }
}

/**
 * WAX/USD from the aux book. Every WAX pool against a trusted stable is an
 * observation; the DEEPEST one anchors (was: first-in-array — arbitrary
 * after the venue merge, could anchor on a thin or depegged book).
 *
 * CLMM trap: raw reserve ratio ≠ spot price when liquidity is concentrated
 * in a tick range. Trust the venue's quoted spot price (priceA = B per 1 A),
 * then the on-chain sqrt-price; reserves are the last resort (Defibox/Taco
 * are CP venues — there the reserve ratio IS the price).
 */
export type WaxAnchor = {
  usd: number;
  tvlUsd: number;
  poolId: number;
  /** Independent observations that survived orientation/trust filters. */
  sources: number;
  /** Spot-tier observations (venue-quoted or on-chain sqrt). */
  spotSources: number;
  /** Max |observation − median| / median, percent. High = books disagree. */
  dispersionPct: number;
  /** 0–1. One observation = LOW by construction; wide dispersion = LOW. */
  confidence: number;
};

/** One pool's price observation — the aggregate fields (sources, dispersion,
 *  confidence) only exist once the anchor is chosen. */
type WaxObservation = Pick<WaxAnchor, "usd" | "tvlUsd" | "poolId"> & { spot: boolean };

/**
 * Every WAX/trusted-stable pool is an observation, in two trust tiers:
 *
 *   spot    — venue-native spot price (Alcor priceA / on-chain sqrt price).
 *             CLMM truth, independent of reserve skew.
 *   reserve — reserve ratio. Correct for CP venues, but a misread table or
 *             a depegged stable poisons it.
 *
 * Spot observations ALWAYS outrank reserve ones — a Defibox/Taco reserve
 * book must never override Alcor's own quoted WAX price. Within a tier the
 * anchor is CLOSEST TO THE MEDIAN (ties → deepest TVL), so one depegged
 * stable or misread venue cannot move the price.
 */
export function waxUsdAnchor(aux: AuxPool[]): WaxAnchor | null {
  const spot: WaxObservation[] = [];
  const reserve: WaxObservation[] = [];
  for (const p of Array.isArray(aux) ? aux : []) {
    const aWax = isWaxToken(p.tokenA);
    const bWax = isWaxToken(p.tokenB);
    if (!aWax && !bWax) continue;
    const stable = aWax ? p.tokenB : p.tokenA;
    if (!isTrustedStable(stable.symbol.toUpperCase(), stable.contract)) continue;
    const wax = aWax ? p.tokenA : p.tokenB;
    const fromApi = aWax ? p.priceA : p.priceB;
    const bPerA = q64Price(p.sqrtPriceX64, p.tokenA.decimals, p.tokenB.decimals);
    const fromSqrt = bPerA != null && bPerA > 0 ? (aWax ? bPerA : 1 / bPerA) : 0;
    const fromReserves =
      wax.quantity > 0 && stable.quantity > 0 ? stable.quantity / wax.quantity : 0;
    if (fromApi && fromApi > 0) {
      spot.push({ usd: fromApi, tvlUsd: p.tvlUsd, poolId: p.id, spot: true });
    } else if (fromSqrt > 0) {
      spot.push({ usd: fromSqrt, tvlUsd: p.tvlUsd, poolId: p.id, spot: true });
    } else if (fromReserves > 0) {
      reserve.push({ usd: fromReserves, tvlUsd: p.tvlUsd, poolId: p.id, spot: false });
    }
  }
  // Spot tier first; reserve tier only when no venue quotes a WAX spot.
  const tier = spot.length > 0 ? spot : reserve;
  if (tier.length === 0) return null;
  const sorted = [...tier].map((o) => o.usd).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  tier.sort((a, b) => Math.abs(a.usd - median) - Math.abs(b.usd - median) || b.tvlUsd - a.tvlUsd);
  const anchor = tier[0]!;
  const maxDev = Math.max(...tier.map((o) => Math.abs(o.usd - median)));
  const dispersionPct = median > 0 ? (maxDev / median) * 100 : 100;
  const sources = tier.length;
  // Confidence: one observation can never be confident. Two agreeing tightly
  // is decent. Three+ tight is strong. Wide dispersion always caps it low.
  const confidence =
    sources >= 3 && dispersionPct <= 0.5
      ? 0.96
      : sources >= 2 && dispersionPct <= 0.5
        ? 0.85
        : sources >= 2 && dispersionPct <= 2
          ? 0.6
          : sources >= 2
            ? 0.4
            : 0.25;
  return { ...anchor, sources, spotSources: spot.length, dispersionPct, confidence };
}

export function waxUsdFromAux(aux: AuxPool[]): number {
  return waxUsdAnchor(aux)?.usd ?? 0;
}

export type UsdAttach = {
  waxUsd: number;
  leefUsd: number;
  waxPerLeef: number;
  /** Oracle quality for the WAX/USD leg — 0 when not live. */
  waxConfidence: number;
  waxSources: number;
  waxDispersionPct: number;
};

export function attachUsdPrices(
  pools: LeefPool[],
  aux: AuxPool[],
  waxUsdHint?: number,
  leefUsdHint?: number,
): UsdAttach {
  // Fresh book math ALWAYS wins; the hint is a fallback for a book with no
  // WAX/stable pool at all. (The on-chain refresh used to pass the old price
  // as the hint, freezing a bad first-load value forever.)
  const anchor = waxUsdAnchor(aux);
  let waxUsd = anchor?.usd ?? 0;
  const livePriced = waxUsd > 0;
  const mainWax = [...pools]
    .filter((p) => isWaxToken(p.pair))
    .sort((a, b) => b.tvlUsd - a.tvlUsd)[0];
  if (!(waxUsd > 0) && waxUsdHint && waxUsdHint > 0) waxUsd = waxUsdHint;
  if (mainWax && !(waxUsd > 0) && mainWax.tvlUsd > 0 && mainWax.pair.quantity > 0) {
    waxUsd = mainWax.tvlUsd / (mainWax.pair.quantity * 2);
  }
  // Not live? Last KNOWN live price — never a hardcoded number. A
  // never-seen-live cold start is UNKNOWN (0), and the trading engine fails
  // closed on it (bot-engine gates on waxConfidence === 0).
  if (!(waxUsd > 0)) waxUsd = lastKnownWaxUsd().usd || 0.006;
  if (livePriced) noteKnownWaxUsd(waxUsd);

  const waxConfidence = livePriced ? anchor!.confidence : 0;
  const waxSources = livePriced ? anchor!.sources : 0;
  const waxDispersionPct = livePriced ? anchor!.dispersionPct : 0;

  const waxPerLeef = mainWax?.waxPerLeef ?? mainWax?.pairPerLeef ?? 0;
  const leefUsd =
    leefUsdHint && leefUsdHint > 0 ? leefUsdHint : waxPerLeef * waxUsd;

  // Canonical per-token conversion map: "SYMBOL@contract" → WAX per token.
  // Symbol alone is NOT identity — a clone "WAXUSDC" on a foreign contract
  // must never borrow the real one's price.
  //
  // VENUE SPOT ONLY: priceA/priceB (or the on-chain sqrt price). Reserve
  // ratios are CP-venue truth but CLMM poison — an Alcor pool's holdings
  // are NOT its price. Missing spot → no conversion, not a wrong one.
  const waxByToken = new Map<string, number>();
  waxByToken.set("WAX@eosio.token", 1);
  for (const p of aux) {
    const aWax = isWaxToken(p.tokenA);
    const bWax = isWaxToken(p.tokenB);
    if (!aWax && !bWax) continue;
    const bPerA = q64Price(p.sqrtPriceX64, p.tokenA.decimals, p.tokenB.decimals);
    // WAX per unit of the OTHER token.
    let waxPerOther: number;
    if (aWax) {
      // A=WAX. priceB = A per 1 B → WAX per other. priceA = B per 1 A → invert.
      const spot =
        p.priceB && p.priceB > 0 ? p.priceB : bPerA != null && bPerA > 0 ? 1 / bPerA : 0;
      waxPerOther = spot;
    } else {
      // B=WAX. priceA = B per 1 A → WAX per other.
      const spot = p.priceA && p.priceA > 0 ? p.priceA : bPerA ?? 0;
      waxPerOther = spot ?? 0;
    }
    if (!(waxPerOther > 0)) continue;
    if (aWax) {
      waxByToken.set(`${p.tokenB.symbol.toUpperCase()}@${p.tokenB.contract}`, waxPerOther);
    } else {
      waxByToken.set(`${p.tokenA.symbol.toUpperCase()}@${p.tokenA.contract}`, waxPerOther);
    }
  }

  for (const p of pools) {
    if (isWaxToken(p.pair)) {
      p.waxPerLeef = p.pairPerLeef;
    } else {
      const pairInWax = waxByToken.get(`${p.pair.symbol.toUpperCase()}@${p.pair.contract}`);
      if (pairInWax && pairInWax > 0) p.waxPerLeef = p.pairPerLeef * pairInWax;
    }
    if (p.waxPerLeef != null) {
      p.usdPerLeef = p.waxPerLeef * waxUsd;
    } else if (isTrustedStable(p.pair.symbol.toUpperCase(), p.pair.contract)) {
      // Only the TRUSTED stable contract prices LEEF directly in USD —
      // a symbol clone on another contract is just another volatile pair.
      p.usdPerLeef = p.pairPerLeef;
    }
    if (p.tvlUsd <= 0) {
      if (isWaxToken(p.pair)) p.tvlUsd = p.pair.quantity * 2 * waxUsd;
      else if (isTrustedStable(p.pair.symbol.toUpperCase(), p.pair.contract)) {
        p.tvlUsd = p.pair.quantity * 2;
      }
    }
  }

  return { waxUsd, leefUsd, waxPerLeef, waxConfidence, waxSources, waxDispersionPct };
}

export function parseSwaps(raw: unknown, pool: LeefPool): LiveTrade[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveTrade[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const tokenA = num(r.tokenA);
    const tokenB = num(r.tokenB);
    const leefDelta = pool.leefIsA ? tokenA : tokenB;
    const pairDelta = pool.leefIsA ? tokenB : tokenA;
    const amountLeef = Math.abs(leefDelta);
    const amountPair = Math.abs(pairDelta);
    if (amountLeef <= 0 && amountPair <= 0) continue;
    const ts = r.time ? new Date(String(r.time)).getTime() : Date.now();
    const pairPerLeef = amountLeef > 0 ? amountPair / amountLeef : pool.pairPerLeef;
    const priceWax =
      pool.pair.symbol.toUpperCase() === "WAX"
        ? pairPerLeef
        : (pool.waxPerLeef ?? pairPerLeef);
    out.push({
      poolId: pool.id,
      pair: `LEEF / ${pool.pair.symbol}`,
      time: new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString(),
      timestamp: Number.isFinite(ts) ? ts : Date.now(),
      type: leefDelta > 0 ? "buy" : "sell",
      priceWax,
      amountLeef,
      amountPair,
      pairSymbol: pool.pair.symbol,
      txHash: String(r.trx_id ?? r._id ?? ""),
      usdVolume: num(r.totalUSDVolume),
      account: String(r.sender ?? r.recipient ?? ""),
    });
  }
  return out;
}
