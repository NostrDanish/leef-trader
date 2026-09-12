import { isWaxToken } from "./amm";
import type { AuxPool, LeefPool } from "./types";
import { LEEF_CONTRACT, LEEF_SYMBOL, WAX_CONTRACT, WAX_SYMBOL } from "./types";

/**
 * The tradable token universe on Alcor/WAX, built from the full pool list.
 * Used by the portfolio rebalancer to value holdings and find routes for
 * any token — not just LEEF pairs.
 */

export type UniverseToken = {
  symbol: string;
  contract: string;
  decimals: number;
  /** Alcor token id, e.g. "waxusdc-eth.token". */
  alcorId: string;
  /** Pool used for valuation (deepest WAX or stable pool). */
  poolId: number;
  /** WAX per 1 token at that pool's spot. */
  waxPerToken: number;
  /** USD per token (waxPerToken × waxUsd; ~1 for stables). */
  usdPrice: number;
  /** TVL of the valuation pool. */
  tvlUsd: number;
  stable: boolean;
};

type RawToken = {
  contract?: string;
  decimals?: number;
  symbol?: string;
  id?: string;
  quantity?: number;
};

type RawPoolRow = {
  id?: number;
  active?: boolean;
  tvlUSD?: number;
  tokenA?: RawToken;
  tokenB?: RawToken;
};

const STABLES = new Set(["USDT", "USDC", "WAXUSDT", "WAXUSDC", "DAI"]);

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Rank every token by its deepest WAX (or stable) pool and price it.
 * Dust books (< $5 TVL valuation pool) are excluded — they misprice and
 * can't be routed meaningfully anyway.
 */
export function buildUniverse(rawPools: unknown, waxUsd: number): UniverseToken[] {
  const list = Array.isArray(rawPools) ? (rawPools as RawPoolRow[]) : [];
  const best = new Map<string, UniverseToken>();

  const consider = (
    tok: RawToken,
    other: RawToken,
    poolId: number,
    tvlUsd: number,
    otherIsWax: boolean,
  ) => {
    const symbol = String(tok.symbol ?? "").toUpperCase();
    const contract = String(tok.contract ?? "");
    const qty = num(tok.quantity);
    const otherQty = num(other.quantity);
    if (!symbol || !contract || qty <= 0 || otherQty <= 0 || tvlUsd < 5) return;

    const otherSym = String(other.symbol ?? "").toUpperCase();
    const stableOther = STABLES.has(otherSym);
    if (!otherIsWax && !stableOther) return;

    // Price: WAX per token (directly for WAX pools, via $-stable pools).
    const waxPerToken = otherIsWax ? otherQty / qty : 0;
    const usdPrice = otherIsWax
      ? (otherQty / qty) * waxUsd
      : qty > 0
        ? otherQty / qty // stable per token ≈ USD
        : 0;
    if (!(usdPrice > 0) || usdPrice > 1e6) return;

    const key = `${symbol}@${contract}`;
    const prev = best.get(key);
    if (prev && prev.tvlUsd >= tvlUsd) return;
    best.set(key, {
      symbol,
      contract,
      decimals: Number(tok.decimals ?? 4) || 4,
      alcorId: `${symbol.toLowerCase()}-${contract}`,
      poolId,
      waxPerToken,
      usdPrice,
      tvlUsd,
      stable: STABLES.has(symbol),
    });
  };

  for (const p of list) {
    if (!p || p.active === false) continue;
    const a = p.tokenA;
    const b = p.tokenB;
    const id = Number(p.id);
    const tvlUsd = num(p.tvlUSD);
    if (!a || !b || !Number.isFinite(id)) continue;
    const aWax = isWaxToken(a);
    const bWax = isWaxToken(b);
    if (aWax || bWax) {
      // WAX pool: price the non-WAX side.
      if (aWax && b) consider(b, a, id, tvlUsd, true);
      if (bWax && a) consider(a, b, id, tvlUsd, true);
      // WAX itself is always in the universe.
      const waxTok = aWax ? a : b;
      if (waxTok && !best.has("WAX@eosio.token")) {
        best.set("WAX@eosio.token", {
          symbol: "WAX",
          contract: "eosio.token",
          decimals: 8,
          alcorId: "wax-eosio.token",
          poolId: id,
          waxPerToken: 1,
          usdPrice: waxUsd,
          tvlUsd,
          stable: false,
        });
      }
      continue;
    }
    // Stable pools (USDT/WAXUSDC…): price the non-stable side in USD.
    const aStable = STABLES.has(String(a.symbol ?? "").toUpperCase());
    const bStable = STABLES.has(String(b.symbol ?? "").toUpperCase());
    if (aStable && !bStable) consider(b, a, id, tvlUsd, false);
    if (bStable && !aStable) consider(a, b, id, tvlUsd, false);
  }

  return [...best.values()].sort((a, b) => b.tvlUsd - a.tvlUsd).slice(0, 60);
}

/** Re-price universe tokens from freshly refreshed pool rows. */
export function repriceUniverse(
  universe: UniverseToken[],
  aux: { id: number; tokenA: { symbol: string; contract: string; quantity: number }; tokenB: { symbol: string; contract: string; quantity: number }; tvlUsd: number }[],
  waxUsd: number,
): UniverseToken[] {
  const byId = new Map(aux.map((p) => [p.id, p]));
  return universe.map((t) => {
    if (t.symbol === "WAX" && t.contract === "eosio.token") {
      return { ...t, usdPrice: waxUsd, waxPerToken: 1 };
    }
    const pool = byId.get(t.poolId);
    if (!pool) return t;
    const matchA =
      pool.tokenA.symbol.toUpperCase() === t.symbol && pool.tokenA.contract === t.contract;
    const matchB =
      pool.tokenB.symbol.toUpperCase() === t.symbol && pool.tokenB.contract === t.contract;
    if (!matchA && !matchB) return t;
    const mine = matchA ? pool.tokenA : pool.tokenB;
    const other = matchA ? pool.tokenB : pool.tokenA;
    if (mine.quantity <= 0 || other.quantity <= 0) return t;
    if (isWaxToken(other)) {
      const wpt = other.quantity / mine.quantity;
      return { ...t, waxPerToken: wpt, usdPrice: wpt * waxUsd, tvlUsd: pool.tvlUsd };
    }
    if (STABLES.has(other.symbol.toUpperCase())) {
      return { ...t, usdPrice: other.quantity / mine.quantity, tvlUsd: pool.tvlUsd };
    }
    return t;
  });
}

/** Case/contract-insensitive lookup. Accepts "WAX", "wax-eosio.token" or "WAX@eosio.token". */
export function findToken(
  universe: UniverseToken[],
  idOrSymbol: string,
): UniverseToken | undefined {
  const s = idOrSymbol.trim();
  const up = s.toUpperCase();
  return (
    universe.find((t) => t.alcorId === s.toLowerCase()) ??
    universe.find((t) => `${t.symbol}@${t.contract}`.toUpperCase() === up) ??
    universe.find((t) => t.symbol === up)
  );
}

export function usdOf(universe: UniverseToken[], idOrSymbol: string): number {
  return findToken(universe, idOrSymbol)?.usdPrice ?? 0;
}

function putToken(map: Map<string, UniverseToken>, t: UniverseToken): void {
  if (!t.symbol || !t.contract || !(t.usdPrice > 0)) return;
  const key = `${t.symbol}@${t.contract}`;
  const prev = map.get(key);
  if (prev && prev.tvlUsd >= t.tvlUsd) return;
  map.set(key, t);
}

/**
 * Keep WAX, LEEF, and every book we already have priced — even when the
 * 11 MB full-list universe hasn't landed yet. The rebalancer cannot value
 * holdings against an empty universe.
 */
export function mergeUniverseFromBook(
  existing: UniverseToken[],
  pools: LeefPool[],
  aux: AuxPool[],
  waxUsd: number,
  leefUsd: number,
): UniverseToken[] {
  const map = new Map<string, UniverseToken>();
  for (const t of existing) putToken(map, t);
  if (waxUsd > 0) {
    putToken(map, {
      symbol: WAX_SYMBOL,
      contract: WAX_CONTRACT,
      decimals: 8,
      alcorId: "wax-eosio.token",
      poolId: 0,
      waxPerToken: 1,
      usdPrice: waxUsd,
      tvlUsd: 0,
      stable: false,
    });
  }
  if (leefUsd > 0) {
    putToken(map, {
      symbol: LEEF_SYMBOL,
      contract: LEEF_CONTRACT,
      decimals: 4,
      alcorId: "leef-leefmaincorp",
      poolId: pools[0]?.id ?? 0,
      waxPerToken: waxUsd > 0 ? leefUsd / waxUsd : 0,
      usdPrice: leefUsd,
      tvlUsd: pools[0]?.tvlUsd ?? 0,
      stable: false,
    });
  }
  for (const p of pools) {
    if (!(p.pair.quantity > 0) || !(p.leef.quantity > 0)) continue;
    const pairUsd =
      p.usdPerLeef && p.pairPerLeef > 0 ? p.usdPerLeef / p.pairPerLeef : 0;
    if (!(pairUsd > 0)) continue;
    putToken(map, {
      symbol: p.pair.symbol.toUpperCase(),
      contract: p.pair.contract,
      decimals: p.pair.decimals,
      alcorId: `${p.pair.symbol.toLowerCase()}-${p.pair.contract}`,
      poolId: p.id,
      waxPerToken: waxUsd > 0 ? pairUsd / waxUsd : 0,
      usdPrice: pairUsd,
      tvlUsd: p.tvlUsd,
      stable: STABLES.has(p.pair.symbol.toUpperCase()),
    });
  }
  for (const p of aux) {
    const aWax = isWaxToken(p.tokenA);
    const bWax = isWaxToken(p.tokenB);
    if (aWax && p.tokenA.quantity > 0 && p.tokenB.quantity > 0 && waxUsd > 0) {
      putToken(map, {
        symbol: p.tokenB.symbol.toUpperCase(),
        contract: p.tokenB.contract,
        decimals: p.tokenB.decimals,
        alcorId: `${p.tokenB.symbol.toLowerCase()}-${p.tokenB.contract}`,
        poolId: p.id,
        waxPerToken: p.tokenA.quantity / p.tokenB.quantity,
        usdPrice: (p.tokenA.quantity / p.tokenB.quantity) * waxUsd,
        tvlUsd: p.tvlUsd,
        stable: STABLES.has(p.tokenB.symbol.toUpperCase()),
      });
    }
    if (bWax && p.tokenB.quantity > 0 && p.tokenA.quantity > 0 && waxUsd > 0) {
      putToken(map, {
        symbol: p.tokenA.symbol.toUpperCase(),
        contract: p.tokenA.contract,
        decimals: p.tokenA.decimals,
        alcorId: `${p.tokenA.symbol.toLowerCase()}-${p.tokenA.contract}`,
        poolId: p.id,
        waxPerToken: p.tokenB.quantity / p.tokenA.quantity,
        usdPrice: (p.tokenB.quantity / p.tokenA.quantity) * waxUsd,
        tvlUsd: p.tvlUsd,
        stable: STABLES.has(p.tokenA.symbol.toUpperCase()),
      });
    }
  }
  return [...map.values()].sort((a, b) => b.tvlUsd - a.tvlUsd);
}
