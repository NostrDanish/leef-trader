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

export const DEFAULT_MIN_TRADE_USD = 0.01;
export const DEFAULT_MAX_POSITION_USD = 1_000;
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
};

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
  /** Effective USD ceiling = min(configured max, spendable, position headroom). */
  effectiveMaxUsd: number;
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
  const minIn = tokenAmountForUsd(Math.max(0, opts.risk.minTradeUsd), quoteUsd);
  if (minIn == null) {
    return { error: `Invalid ${quote} USD price — sitting out` };
  }
  const positionUsd = positionMarkUsd(opts.position, opts.snap, opts.base);
  const remainingUsd = Math.max(0, opts.risk.maxPositionUsd - positionUsd);
  const walletQuote = balanceForIdentifier(opts.balances, opts.snap.universe, quote);
  const walletUsd = walletQuote * quoteUsd;
  const reserveUsd = Math.max(0, opts.risk.operationalReserveUsd ?? 0);
  const spendableUsd = Math.max(0, walletUsd - reserveUsd);
  const effectiveMaxUsd = Math.min(
    Math.max(0, opts.risk.maxPositionUsd),
    spendableUsd,
    remainingUsd,
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
      "Risk settings now use USD value (min trade $0.01 / max position $1,000). Previous WAX clip/max were quote-token units and were not converted into dollars.",
  };
}
