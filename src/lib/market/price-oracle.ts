/**
 * Authoritative token-price oracle.
 *
 * Economic callers do not read `universe[].usdPrice` directly. They ask this
 * layer for a contract-aware price carrying provenance, age, confidence,
 * liquidity and stablecoin risk state.
 *
 * Trusted stables expose TWO prices:
 *  - marketPriceUsd: what the deepest observed venue currently implies;
 *  - priceUsd: the bounded portfolio/risk valuation anchor.
 *
 * A weak/tiny or severely divergent market cannot turn 53 WAXUSDC into $23.
 * If strong evidence shows a depeg, the state is DEPEGGED and `tradeAllowed`
 * is false; the anchor remains visible for accounting alongside the market
 * observation. We never hide the disagreement.
 */
import type { LeefSnapshot } from "@/lib/leef/types";
import type { UniverseToken } from "@/lib/leef/universe";
import {
  canonicalTokenId,
  isTrustedStable,
  trustedStableOf,
  type StableState,
} from "./stables";

export type PriceSource =
  | "stable-anchor+alcor"
  | "stable-anchor"
  | "alcor-wax"
  | "alcor-stable"
  | "alcor-leef"
  | "market-book"
  | "unknown";

export type TokenPrice = {
  symbol: string;
  contract: string;
  tokenId: string;
  priceUsd: number;
  marketPriceUsd: number | null;
  waxPerToken: number;
  source: PriceSource;
  timestamp: number;
  ageMs: number;
  confidence: number;
  liquidityUsd: number;
  stable: boolean;
  targetUsd: number | null;
  deviationPct: number | null;
  stableState: StableState | null;
  tradeAllowed: boolean;
  reason: string;
};

export const MIN_TRADING_PRICE_CONFIDENCE = 0.7;
/** Execution state is considered stale after 75s; callers refresh at ~8s. */
export const MAX_TRADING_PRICE_AGE_MS = 75_000;
export const MAX_STABLE_TRADE_DEVIATION_PCT = 5;
const STRONG_DEPEG_LIQUIDITY_USD = 10_000;

function sourceFor(t: UniverseToken): PriceSource {
  if (t.stable) return t.priceSource ?? "stable-anchor+alcor";
  if (t.symbol === "WAX") return "alcor-stable";
  if (t.symbol === "LEEF") return "alcor-leef";
  if (t.waxPerToken > 0) return "alcor-wax";
  return t.priceSource ?? "market-book";
}

/** Exact canonical lookup, or symbol-only only when it is unambiguous. */
export function resolveOracleToken(
  universe: UniverseToken[],
  identifier: string,
): UniverseToken | null {
  const raw = identifier.trim();
  const up = raw.toUpperCase();
  const exact =
    universe.find((t) => t.alcorId === raw.toLowerCase()) ??
    universe.find((t) => canonicalTokenId(t.symbol, t.contract).toUpperCase() === up);
  if (exact) return exact;
  if (raw.includes("@") || raw.includes("-")) return null;
  const matches = universe.filter((t) => t.symbol.toUpperCase() === up);
  return matches.length === 1 ? matches[0]! : null;
}

function stablePrice(t: UniverseToken, timestamp: number, now: number): TokenPrice {
  const stable = trustedStableOf(t.symbol, t.contract)!;
  const target = stable.targetUsd;
  const observed = t.marketPriceUsd && t.marketPriceUsd > 0 ? t.marketPriceUsd : t.usdPrice;
  const deviationPct = observed > 0 ? Math.abs(observed / target - 1) * 100 : null;
  const state = t.stableState ?? "UNKNOWN";
  const strongDepeg =
    state === "DEPEGGED" &&
    t.tvlUsd >= STRONG_DEPEG_LIQUIDITY_USD &&
    (t.priceConfidence ?? 0) >= 0.7;
  // Portfolio accounting uses the stable target when an observation is weak
  // or divergent. Strong depeg evidence is surfaced separately and blocks
  // trading; no caller can mistake the anchor for an executable market price.
  const priceUsd =
    state === "PEGGED" || state === "MINOR_DEVIATION" ? observed : target;
  const confidence = Math.max(0, Math.min(1, t.priceConfidence ?? (state === "UNKNOWN" ? 0.55 : 0.9)));
  const ageMs = Math.max(0, now - timestamp);
  const deviationBlocked = (deviationPct ?? Infinity) > MAX_STABLE_TRADE_DEVIATION_PCT;
  const tradeAllowed =
    !strongDepeg &&
    !deviationBlocked &&
    confidence >= MIN_TRADING_PRICE_CONFIDENCE &&
    ageMs <= MAX_TRADING_PRICE_AGE_MS;
  return {
    symbol: t.symbol,
    contract: t.contract,
    tokenId: canonicalTokenId(t.symbol, t.contract),
    priceUsd,
    marketPriceUsd: observed > 0 ? observed : null,
    waxPerToken: t.waxPerToken,
    source: sourceFor(t),
    timestamp,
    ageMs,
    confidence,
    liquidityUsd: t.tvlUsd,
    stable: true,
    targetUsd: target,
    deviationPct,
    stableState: state,
    tradeAllowed,
    reason: tradeAllowed
      ? `${state.toLowerCase()} stable; market ${(observed || target).toFixed(4)} vs $${target.toFixed(2)} target`
      : strongDepeg || deviationBlocked
        ? `${state.toLowerCase()} stable (${(deviationPct ?? 0).toFixed(1)}% deviation) — blocked for trading`
        : `stable price confidence/age is insufficient for trading`,
  };
}

export function tokenPrice(
  snap: Pick<LeefSnapshot, "universe" | "fetchedAt" | "spotAt" | "waxUsd" | "leefUsd">,
  identifier: string,
  now = Date.now(),
): TokenPrice | null {
  const t = resolveOracleToken(snap.universe, identifier);
  if (!t) return null;
  const parsedTimestamp = Date.parse(snap.spotAt ?? snap.fetchedAt);
  // Snapshot/chain spot time is the freshness of the assembled market state;
  // per-token timestamps are provenance only and can be older after a cached
  // universe merge. Use the newest trusted timestamp without masking staleness.
  const snapshotTimestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0;
  const timestamp = Math.max(t.priceTimestamp ?? 0, snapshotTimestamp) || now;
  if (isTrustedStable(t.symbol, t.contract)) return stablePrice(t, timestamp, now);
  const confidence = Math.max(
    0,
    Math.min(
      1,
      t.priceConfidence ?? Math.min(0.95, 0.45 + Math.log10(Math.max(1, t.tvlUsd)) / 10),
    ),
  );
  const ageMs = Math.max(0, now - timestamp);
  const priceUsd =
    t.symbol === "WAX"
      ? (snap.waxUsd > 0 ? snap.waxUsd : t.usdPrice)
      : t.symbol === "LEEF"
        ? (snap.leefUsd > 0 ? snap.leefUsd : t.usdPrice)
        : t.usdPrice;
  // Core WAX/LEEF marks are continuously refreshed by the engine and trusted
  // with a lower liquidity floor; discovered long-tail tokens still need the
  // normal confidence score.
  const core = t.symbol === "WAX" || t.symbol === "LEEF";
  const effectiveConfidence = core ? Math.max(confidence, 0.85) : confidence;
  const tradeAllowed =
    priceUsd > 0 &&
    effectiveConfidence >= MIN_TRADING_PRICE_CONFIDENCE &&
    ageMs <= MAX_TRADING_PRICE_AGE_MS;
  return {
    symbol: t.symbol,
    contract: t.contract,
    tokenId: canonicalTokenId(t.symbol, t.contract),
    priceUsd,
    marketPriceUsd: priceUsd > 0 ? priceUsd : null,
    waxPerToken: t.waxPerToken,
    source: sourceFor(t),
    timestamp,
    ageMs,
    confidence: effectiveConfidence,
    liquidityUsd: t.tvlUsd,
    stable: false,
    targetUsd: null,
    deviationPct: null,
    stableState: null,
    tradeAllowed,
    reason: tradeAllowed
      ? `${sourceFor(t)} price with ${(effectiveConfidence * 100).toFixed(0)}% confidence`
      : `price is stale or confidence ${(effectiveConfidence * 100).toFixed(0)}% is below trading minimum`,
  };
}

/** Fail-closed trading gate with an actionable journal reason. */
export function requireTradePrice(
  snap: Pick<LeefSnapshot, "universe" | "fetchedAt" | "spotAt" | "waxUsd" | "leefUsd">,
  identifier: string,
  now = Date.now(),
): TokenPrice | { error: string } {
  const p = tokenPrice(snap, identifier, now);
  if (!p || !(p.priceUsd > 0)) return { error: `No authoritative USD price for ${identifier}` };
  if (!p.tradeAllowed) return { error: `${p.symbol} price uncertain: ${p.reason}` };
  return p;
}
