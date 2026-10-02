/**
    * USD value is the user-facing risk abstraction.
    * Token quantities remain the execution abstraction.
    *
    *   minTradeUsd / maxPositionUsd
    *     → current quote-token USD mark
    *     → token amounts
    *     → router / net-edge / signer
    *
    * Never treat a WAX (or USDC) quantity as if it were dollars.
    */
import { usdPriceOf } from "./cost-model";
import { requireTradePrice } from "@/lib/market/price-oracle";
import { balanceForIdentifier } from "@/lib/wallet/balances";
import type { LeefSnapshot } from "./types";

/** Dust floor: one hundred-millionth of a dollar. WAX tokens often print
 *  10M units per $1; a 1-unit fill can be $1e-10. The engine still refuses
 *  sizes that round to 0 at token precision. */
export const DEFAULT_MIN_TRADE_USD = 0;
export const DEFAULT_MAX_POSITION_USD = 100;
export const ABSOLUTE_MIN_TRADE_USD = 0;
/** Reserve held back in the quote token so the wallet keeps operating capital. */
export const DEFAULT_OPERATIONAL_RESERVE_USD = 0;

/** Convert a USD notional to quote-token units at a live mark. */
export function tokenAmountForUsd(usd: number, quoteUsd: number): number | null {
  if (!(usd >= 0) || !Number.isFinite(usd) || !(quoteUsd > 0) || !Number.isFinite(quoteUsd)) {
    return null;
  }
  return usd / quoteUsd;
}

export type UsdRisk = {
  minTradeUsd: number;
  maxPositionUsd: number;
  /** USD value the governor keeps unspent for operational safety. */
  operationalReserveUsd: number;
  /**
   * Cap positions at this percent of the deepest direct base/quote pool's
   * TVL. Undefined / 0 = no liquidity cap.
   */
  maxPoolSharePct?: number;
};

/**
 * TVL (USD) of the deepest DIRECT pool trading base↔quote in the snapshot
 * (LEEF pools + aux pools, matched by symbol). null when the pair has no
 * direct pool (multi-hop only) — the per-route impact cap still applies then.
 */
export function deepestPairTvlUsd(
  snap: Pick<LeefSnapshot, "pools" | "aux">,
  base: string,
  quote: string,
): number | null {
  const want = new Set([base.toUpperCase(), quote.toUpperCase()]);
  if (want.size !== 2) return null;
  const pair = (a: string, b: string) => want.has(a.toUpperCase()) && want.has(b.toUpperCase()) && a.toUpperCase() !== b.toUpperCase();
  let best: number | null = null;
  const consider = (tvl: number) => {
    const v = Number.isFinite(tvl) ? Math.max(0, tvl) : 0;
    best = best == null ? v : Math.max(best, v);
  };
  for (const p of snap.pools ?? []) if (pair(p.leef.symbol, p.pair.symbol)) consider(p.tvlUsd);
  for (const p of snap.aux ?? []) if (pair(p.tokenA.symbol, p.tokenB.symbol)) consider(p.tvlUsd);
  return best;
}

export type MarkedPosition = {
  /** Amount of the base token held (legacy field name was `amountLeef`). */
  amountLeef: number;
  entryCostUsd: number;
};

/** Current market value of an open position in USD. */
export function positionMarkUsd(
  position: MarkedPosition | null,
  snap: LeefSnapshot,
  base = "LEEF",
): number {
  if (!position || !(position.amountLeef > 0)) return 0;
  const px = usdPriceOf(base, snap);
  if (px > 0) return position.amountLeef * px;
  // Unknown mark — fail closed: don't free capacity we can't value.
  return Math.max(0, position.entryCostUsd);
}

export type UsdBounds = {
  quoteUsd: number;
  minIn: number;
  maxIn: number;
  positionUsd: number;
  remainingUsd: number;
  walletQuote: number;
  /** USD value of the wallet's quote-token balance (authoritative mark). */
  walletUsd: number;
  /** Spendable USD after operational reserve is held back. */
  spendableUsd: number;
  /** Effective USD ceiling = min(configured max, liquidity cap, spendable, position headroom). */
  effectiveMaxUsd: number;
  /**
   * Liquidity cap = maxPoolSharePct × deepest direct pool TVL (USD), when it
   * applies. Lets the desk show the binding constraint.
   */
  liquidityCapUsd?: number;
};

/**
    * Convert USD risk limits into quote-token amounts for THIS book.
    *
    * Wallet-safe sizing:
    *   effectiveMaximumUsd = min(configuredMaxUsd, spendableBalanceUsd, positionHeadroomUsd)
    *   spendableBalanceUsd = walletUsd − operationalReserveUsd
    * A trade is only allowed if effectiveMaximumUsd >= minTradeUsd.
    */
export function usdToTokenBounds(opts: {
  snap: LeefSnapshot;
  quote: string;
  base: string;
  risk: UsdRisk;
  position: MarkedPosition | null;
  balances: Record<string, number>;
}): UsdBounds | { error: string } {
  const quote = opts.quote.toUpperCase();
  const authoritative = requireTradePrice(opts.snap, quote);
  if ("error" in authoritative) return { error: authoritative.error };
  const quoteUsd = authoritative.priceUsd;
  const minInRaw = tokenAmountForUsd(Math.max(0, opts.risk.minTradeUsd), quoteUsd);
  if (minInRaw == null) {
    return { error: `Invalid ${quote} USD price — sitting out` };
  }
  // Never require more than one quantum of the quote token when the user
  // asked for dust. A $0 min with WAX@8dp means 0.00000001 WAX, not "no trade".
  const minIn = minInRaw;
  const positionUsd = positionMarkUsd(opts.position, opts.snap, opts.base);
  const remainingUsd = Math.max(0, opts.risk.maxPositionUsd - positionUsd);
  const walletQuote = balanceForIdentifier(opts.balances, opts.snap.universe, quote);
  const walletUsd = walletQuote * quoteUsd;
  const reserveUsd = Math.max(0, opts.risk.operationalReserveUsd ?? 0);
  const spendableUsd = Math.max(0, walletUsd - reserveUsd);
  // Liquidity-relative cap: never size a position beyond a share of the
  // deepest direct pool. A direct pool with unknown/zero TVL fails closed
  // (cap 0); a pair with no direct pool is left to the route impact cap.
  const share = Math.max(0, opts.risk.maxPoolSharePct ?? 0);
  const tvl = share > 0 ? deepestPairTvlUsd(opts.snap, opts.base, quote) : null;
  const liquidityCapUsd = tvl == null ? undefined : tvl * (share / 100);
  // Position headroom under the liquidity cap (it bounds the POSITION, like maxPositionUsd).
  const liquidityHeadroomUsd =
    liquidityCapUsd == null ? Number.POSITIVE_INFINITY : Math.max(0, liquidityCapUsd - positionUsd);
  const effectiveMaxUsd = Math.min(
    Math.max(0, opts.risk.maxPositionUsd),
    spendableUsd,
    remainingUsd,
    liquidityHeadroomUsd,
  );
  // Convert the USD ceiling back to quote-token units.
  const maxIn = effectiveMaxUsd / quoteUsd;
  return {
    quoteUsd,
    minIn,
    maxIn,
    positionUsd,
    remainingUsd,
    walletQuote,
    walletUsd,
    spendableUsd,
    effectiveMaxUsd,
    ...(liquidityCapUsd != null ? { liquidityCapUsd } : {}),
  };
}

/** True when this fill would push marked exposure above the USD cap. */
export function exceedsMaxPositionUsd(opts: {
  snap: LeefSnapshot;
  base: string;
  risk: UsdRisk;
  position: MarkedPosition | null;
  extraBaseAmount: number;
}): boolean {
  const current = positionMarkUsd(opts.position, opts.snap, opts.base);
  const px = usdPriceOf(opts.base, opts.snap);
  if (!(px > 0)) return true;
  const next = current + Math.max(0, opts.extraBaseAmount) * px;
  return next - 1e-9 > opts.risk.maxPositionUsd;
}

export type LegacyRiskBlob = {
  minTradeUsd?: unknown;
  maxPositionUsd?: unknown;
  operationalReserveUsd?: unknown;
  clipWax?: unknown;
  maxPositionWax?: unknown;
};

/**
    * Persist migration. Old clipWax / maxPositionWax were quote-token units.
    * We do NOT multiply them by 1 and call them dollars. Without a stored
    * contemporaneous quote-token USD price, conversion is unsafe — fall back
    * to product defaults and tell the user.
    */
export function migrateRiskToUsd(raw: LegacyRiskBlob | undefined): {
  minTradeUsd: number;
  maxPositionUsd: number;
  operationalReserveUsd: number;
  notice: string | null;
} {
  const r = raw ?? {};
  const minUsd = typeof r.minTradeUsd === "number" && Number.isFinite(r.minTradeUsd) ? r.minTradeUsd : null;
  const maxUsd =
    typeof r.maxPositionUsd === "number" && Number.isFinite(r.maxPositionUsd) ? r.maxPositionUsd : null;
  const reserveUsd =
    typeof r.operationalReserveUsd === "number" && Number.isFinite(r.operationalReserveUsd) && r.operationalReserveUsd >= 0
      ? r.operationalReserveUsd
      : DEFAULT_OPERATIONAL_RESERVE_USD;
  if (minUsd != null && maxUsd != null && minUsd >= 0 && maxUsd > 0) {
    return {
      minTradeUsd: minUsd,
      maxPositionUsd: Math.max(maxUsd, minUsd),
      operationalReserveUsd: reserveUsd,
      notice: null,
    };
  }
  return {
    minTradeUsd: DEFAULT_MIN_TRADE_USD,
    maxPositionUsd: DEFAULT_MAX_POSITION_USD,
    operationalReserveUsd: reserveUsd,
    notice:
      "Risk settings now use USD value (min trade $0 / max position $100). Previous WAX clip/max were quote-token units and were not converted into dollars. WAX micropayments can be dust-sized.",
  };
}
