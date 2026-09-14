import { isWaxToken } from "./amm";
import type { AuxPool, LeefPool } from "./types";
import { LEEF_CONTRACT, LEEF_SYMBOL, WAX_CONTRACT, WAX_SYMBOL } from "./types";
import {
  isTrustedStable,
  stableUsdPrice,
  type StableState,
} from "@/lib/market/stables";
import type { PriceSource } from "@/lib/market/price-oracle";
import { registryToken } from "./token-registry";

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
  /** USD per token (waxPerToken × waxUsd; oracle-priced for trusted stables). */
  usdPrice: number;
  /** TVL of the valuation pool. */
  tvlUsd: number;
  stable: boolean;
  /** Trusted-stable oracle state (PEGGED/…/UNKNOWN) when `stable`. */
  stableState?: StableState;
  /** 0..1 price confidence from the authoritative price oracle. */
  priceConfidence?: number;
  /** Raw market observation (may differ from stable target valuation). */
  marketPriceUsd?: number;
  /** Human/machine-readable price provenance. */
  priceSource?: PriceSource;
  /** Unix ms when this token price was last derived. */
  priceTimestamp?: number;
  /** Alcor venue score 0–99 (0 = unlisted). */
  alcorScore?: number;
  /** Venue-flagged scam — hard-excluded from routing and pricing. */
  alcorScam?: boolean;
  /** Venue-trusted flag from the Alcor registry. */
  alcorTrusted?: boolean;
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

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};

/** Oracle-price a trusted stable's raw observation; pass through otherwise. */
function priceWithStableOracle(
  symbol: string,
  contract: string,
  observedUsd: number,
  liquidityUsd: number,
): {
  usdPrice: number;
  stable: boolean;
  stableState?: StableState;
  priceConfidence?: number;
  marketPriceUsd: number;
  priceSource: PriceSource;
  priceTimestamp: number;
} {
  if (!isTrustedStable(symbol, contract)) {
    // Symbol clone on a foreign contract: NOT a stable — price it as-is and
    // never force it to $1.
    return {
      usdPrice: observedUsd,
      stable: false,
      marketPriceUsd: observedUsd,
      priceSource: "alcor-wax",
      priceTimestamp: Date.now(),
    };
  }
  const oracle = stableUsdPrice(observedUsd, { liquidityUsd });
  return {
    usdPrice: oracle.usdPrice,
    stable: true,
    stableState: oracle.state,
    priceConfidence: oracle.confidence,
    marketPriceUsd: observedUsd,
    priceSource: "stable-anchor+alcor",
    priceTimestamp: Date.now(),
  };
}

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
    const stableOther = isTrustedStable(otherSym, String(other.contract ?? ""));
    if (!otherIsWax && !stableOther) return;

    // Price: WAX per token (directly for WAX pools, via $-stable pools).
    const rawUsd = otherIsWax
      ? (otherQty / qty) * waxUsd
      : otherQty / qty; // stable per token ≈ USD (trusted contract only)
    if (!(rawUsd > 0) || rawUsd > 1e6) return;
    const oracle = priceWithStableOracle(symbol, contract, rawUsd, tvlUsd);
    if (!(oracle.usdPrice > 0) || oracle.usdPrice > 1e6) return;

    const key = `${symbol}@${contract}`;
    const prev = best.get(key);
    if (prev && prev.tvlUsd >= tvlUsd) return;
    best.set(key, {
      symbol,
      contract,
      decimals: Number(tok.decimals ?? 4) || 4,
      alcorId: `${symbol.toLowerCase()}-${contract}`,
      poolId,
      waxPerToken: otherIsWax ? otherQty / qty : 0,
      usdPrice: oracle.usdPrice,
      tvlUsd,
      stable: oracle.stable,
      stableState: oracle.stableState,
      priceConfidence: oracle.priceConfidence,
      marketPriceUsd: oracle.marketPriceUsd,
      priceSource: oracle.priceSource,
      priceTimestamp: oracle.priceTimestamp,
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
    // Trusted-stable pools (WAXUSDC@eth.token, USDT@usdt.alcor…): price the
    // non-stable side in USD. Symbol clones on other contracts don't count.
    const aStable = isTrustedStable(
      String(a.symbol ?? "").toUpperCase(),
      String(a.contract ?? ""),
    );
    const bStable = isTrustedStable(
      String(b.symbol ?? "").toUpperCase(),
      String(b.contract ?? ""),
    );
    if (aStable && !bStable) consider(b, a, id, tvlUsd, false);
    if (bStable && !aStable) consider(a, b, id, tvlUsd, false);
  }

  // Venue verification overlay: Alcor's own score/flags annotate every token.
  // Scam-flagged tokens are REMOVED — a scam token must never be priced,
  // routed, or suggested. Fail closed.
  const out: UniverseToken[] = [];
  for (const t of best.values()) {
    const reg = registryToken(`${t.symbol}@${t.contract}`);
    if (reg?.is_scam) continue;
    out.push({
      ...t,
      alcorScore: reg?.score ?? 0,
      alcorTrusted: reg?.is_trusted ?? false,
    });
  }
  return out.sort((a, b) => b.tvlUsd - a.tvlUsd).slice(0, 60);
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
      const oracle = priceWithStableOracle(
        t.symbol,
        t.contract,
        wpt * waxUsd,
        pool.tvlUsd,
      );
      return {
        ...t,
        waxPerToken: wpt,
        usdPrice: oracle.usdPrice,
        tvlUsd: pool.tvlUsd,
        stable: oracle.stable,
        stableState: oracle.stableState,
        priceConfidence: oracle.priceConfidence,
        marketPriceUsd: oracle.marketPriceUsd,
        priceSource: oracle.priceSource,
        priceTimestamp: oracle.priceTimestamp,
      };
    }
    if (isTrustedStable(other.symbol.toUpperCase(), other.contract)) {
      const oracle = priceWithStableOracle(
        t.symbol,
        t.contract,
        other.quantity / mine.quantity,
        pool.tvlUsd,
      );
      return {
        ...t,
        usdPrice: oracle.usdPrice,
        tvlUsd: pool.tvlUsd,
        stable: oracle.stable,
        stableState: oracle.stableState,
        priceConfidence: oracle.priceConfidence,
        marketPriceUsd: oracle.marketPriceUsd,
        priceSource: oracle.priceSource,
        priceTimestamp: oracle.priceTimestamp,
      };
    }
    return t;
  });
}

/**
 * Contract-aware lookup. Accepts an Alcor id or SYMBOL@CONTRACT. A bare
 * symbol resolves ONLY when the universe contains exactly one matching
 * contract; ambiguous symbols fail closed instead of picking whichever row
 * happened to sort first.
 */
export function findToken(
  universe: UniverseToken[],
  idOrSymbol: string,
): UniverseToken | undefined {
  const s = idOrSymbol.trim();
  const up = s.toUpperCase();
  const exact =
    universe.find((t) => t.alcorId === s.toLowerCase()) ??
    universe.find((t) => `${t.symbol}@${t.contract}`.toUpperCase() === up);
  if (exact) return exact;
  if (s.includes("@") || s.includes("-")) return undefined;
  const matches = universe.filter((t) => t.symbol === up);
  return matches.length === 1 ? matches[0] : undefined;
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
    const oracle = priceWithStableOracle(
      p.pair.symbol.toUpperCase(),
      p.pair.contract,
      pairUsd,
      p.tvlUsd,
    );
    putToken(map, {
      symbol: p.pair.symbol.toUpperCase(),
      contract: p.pair.contract,
      decimals: p.pair.decimals,
      alcorId: `${p.pair.symbol.toLowerCase()}-${p.pair.contract}`,
      poolId: p.id,
      waxPerToken: waxUsd > 0 ? oracle.usdPrice / waxUsd : 0,
      usdPrice: oracle.usdPrice,
      tvlUsd: p.tvlUsd,
      stable: oracle.stable,
      stableState: oracle.stableState,
      priceConfidence: oracle.priceConfidence,
      marketPriceUsd: oracle.marketPriceUsd,
      priceSource: oracle.priceSource,
      priceTimestamp: oracle.priceTimestamp,
    });
  }
  for (const p of aux) {
    const aWax = isWaxToken(p.tokenA);
    const bWax = isWaxToken(p.tokenB);
    if (aWax && p.tokenA.quantity > 0 && p.tokenB.quantity > 0 && waxUsd > 0) {
      const oracle = priceWithStableOracle(
        p.tokenB.symbol.toUpperCase(),
        p.tokenB.contract,
        (p.tokenA.quantity / p.tokenB.quantity) * waxUsd,
        p.tvlUsd,
      );
      putToken(map, {
        symbol: p.tokenB.symbol.toUpperCase(),
        contract: p.tokenB.contract,
        decimals: p.tokenB.decimals,
        alcorId: `${p.tokenB.symbol.toLowerCase()}-${p.tokenB.contract}`,
        poolId: p.id,
        waxPerToken: p.tokenA.quantity / p.tokenB.quantity,
        usdPrice: oracle.usdPrice,
        tvlUsd: p.tvlUsd,
        stable: oracle.stable,
        stableState: oracle.stableState,
        priceConfidence: oracle.priceConfidence,
        marketPriceUsd: oracle.marketPriceUsd,
        priceSource: oracle.priceSource,
        priceTimestamp: oracle.priceTimestamp,
      });
    }
    if (bWax && p.tokenB.quantity > 0 && p.tokenA.quantity > 0 && waxUsd > 0) {
      const oracle = priceWithStableOracle(
        p.tokenA.symbol.toUpperCase(),
        p.tokenA.contract,
        (p.tokenB.quantity / p.tokenA.quantity) * waxUsd,
        p.tvlUsd,
      );
      putToken(map, {
        symbol: p.tokenA.symbol.toUpperCase(),
        contract: p.tokenA.contract,
        decimals: p.tokenA.decimals,
        alcorId: `${p.tokenA.symbol.toLowerCase()}-${p.tokenA.contract}`,
        poolId: p.id,
        waxPerToken: p.tokenB.quantity / p.tokenA.quantity,
        usdPrice: oracle.usdPrice,
        tvlUsd: p.tvlUsd,
        stable: oracle.stable,
        stableState: oracle.stableState,
        priceConfidence: oracle.priceConfidence,
        marketPriceUsd: oracle.marketPriceUsd,
        priceSource: oracle.priceSource,
        priceTimestamp: oracle.priceTimestamp,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.tvlUsd - a.tvlUsd);
}
