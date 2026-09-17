/**
 * LEEF Trader platform fee — 0.001% to `smart.ass`, once per trade.
 *
 * Design invariants (do not weaken):
 *
 *  - Charged on the GUARANTEED output (the on-chain min-out), never the
 *    optimistic quote — the fee never depends on a number the venue can't
 *    guarantee.
 *  - Denominated in the OUTPUT token, appended as ONE transfer action inside
 *    the same atomic transaction. A reverted trade reverts the fee too —
 *    failed transactions never pay. No second transaction, ever.
 *  - Floored at the token's precision; when the fee rounds to zero units the
 *    action is skipped. Flooring means the effective rate can never exceed
 *    the configured rate (no upward rounding).
 *  - The constants below are the ONLY source of the rate and recipient. Not
 *    configurable by users, AI, learning, routes, venues, or URLs. A quote
 *    or API response can never redirect the fee — the recipient is a
 *    compile-time constant and the policy firewall enforces it.
 *  - Exactly once per logical trade: never per hop, never per split slice.
 *    A rebalance sweep charges once per swept conversion (each leg is its
 *    own conversion); cycles charge once on the final output.
 */

export const PLATFORM_FEE_RATE = 0.00001; // 0.001%
export const PLATFORM_FEE_BPS = 0.1;
/** Percent units, for the percent-based cost model. */
export const PLATFORM_FEE_PCT = 0.001;
export const PLATFORM_FEE_ACCOUNT = "smart.ass";
export const PLATFORM_FEE_MEMO = "leef-trader platform fee (0.001%)";

export type FeeToken = { symbol: string; contract: string; decimals: number };

export type PlatformFeeSpec = {
  /** Fee amount in token units (floored to precision). */
  amount: number;
  /** Chain-formatted asset string, e.g. "0.00100000 WAX". */
  quantity: string;
  token: FeeToken;
  recipient: string;
};

/**
 * Fee on a guaranteed output amount. Returns null when the fee rounds to
 * zero units — no dust transfer, no upward rounding.
 */
export function platformFeeOn(
  guaranteedOut: number,
  token: FeeToken,
): PlatformFeeSpec | null {
  if (!(guaranteedOut > 0) || !(token.decimals >= 0)) return null;
  const scale = Math.pow(10, token.decimals);
  const units = Math.floor(guaranteedOut * PLATFORM_FEE_RATE * scale);
  if (units <= 0) return null;
  const amount = units / scale;
  return {
    amount,
    quantity: `${amount.toFixed(token.decimals)} ${token.symbol.toUpperCase()}`,
    token,
    recipient: PLATFORM_FEE_ACCOUNT,
  };
}

/** USD value of a fee spec (accounting/journal only). */
export function platformFeeUsd(fee: PlatformFeeSpec | null, usdPrice: number): number {
  return fee && usdPrice > 0 ? fee.amount * usdPrice : 0;
}
