/**
 * Trusted stable-asset registry + stable price oracle.
 *
 * Canonical identity is SYMBOL@CONTRACT — never a symbol alone. Two tokens
 * can both be called "WAXUSDC"; only the one issued by the trusted contract
 * is treated as a dollar stable. Everything else is priced by its own pools
 * like any volatile token (fail closed against symbol-clone scams).
 *
 * Prices for trusted stables flow through the oracle states:
 *
 *   PEGGED           |dev| ≤ 0.5%   and real liquidity  → observed price
 *   MINOR_DEVIATION  |dev| ≤ 2%                      → observed (flagged)
 *   STRESSED         |dev| ≤ 10%                     → observed (flagged)
 *   DEPEGGED         |dev| > 10%                      → observed — honest,
 *                       we do NOT pretend it is $1
 *   UNKNOWN          no usable observation            → $1 prior, low
 *                       confidence (trusted contract only)
 */

export type StableState =
  | "PEGGED"
  | "MINOR_DEVIATION"
  | "STRESSED"
  | "DEPEGGED"
  | "UNKNOWN";

export type TrustedStable = {
  symbol: string;
  contract: string;
  targetUsd: number;
};

/**
 * Verified WAX mainnet stable assets (symbol + ISSUING CONTRACT).
 * Contracts cross-checked against the Alcor token registry ids used by the
 * app's token catalog (waxusdc-eth.token, usdt-usdt.alcor, …).
 */
export const TRUSTED_STABLES: TrustedStable[] = [
  { symbol: "WAXUSDC", contract: "eth.token", targetUsd: 1 },
  { symbol: "WAXUSDT", contract: "eth.token", targetUsd: 1 },
  { symbol: "USDT", contract: "usdt.alcor", targetUsd: 1 },
  { symbol: "PARAUSD", contract: "parareserves", targetUsd: 1 },
];

export function canonicalTokenId(symbol: string, contract: string): string {
  return `${symbol.toUpperCase()}@${contract}`;
}

export function trustedStableOf(
  symbol: string,
  contract: string,
): TrustedStable | null {
  const s = symbol.toUpperCase();
  const c = contract.toLowerCase();
  return (
    TRUSTED_STABLES.find((t) => t.symbol === s && t.contract.toLowerCase() === c) ?? null
  );
}

export function isTrustedStable(symbol: string, contract: string): boolean {
  return trustedStableOf(symbol, contract) != null;
}

/** Minimum pool liquidity before an observation is trusted, USD. */
export const STABLE_MIN_LIQ_USD = 2_000;

export function stableStateFor(
  observedUsd: number,
  targetUsd: number,
  liquidityUsd: number,
): StableState {
  if (!(observedUsd > 0) || !(targetUsd > 0)) return "UNKNOWN";
  if (liquidityUsd < STABLE_MIN_LIQ_USD) return "UNKNOWN";
  const dev = Math.abs(observedUsd / targetUsd - 1);
  if (dev <= 0.005) return "PEGGED";
  if (dev <= 0.02) return "MINOR_DEVIATION";
  if (dev <= 0.1) return "STRESSED";
  return "DEPEGGED";
}

export type StablePrice = {
  /** USD price to value the asset at. */
  usdPrice: number;
  state: StableState;
  /** Observed vs target, percent (signed). */
  deviationPct: number;
  /** 0..1 — how much to trust this price. */
  confidence: number;
};

/**
 * Oracle price for a TRUSTED stable. Observed = deepest-pool derived price.
 * Unknown states fall back to the $1 prior (trusted issuer only) with low
 * confidence; depegged states stay honest.
 */
export function stableUsdPrice(
  observedUsd: number,
  opts: { targetUsd?: number; liquidityUsd?: number } = {},
): StablePrice {
  const targetUsd = opts.targetUsd ?? 1;
  const liq = opts.liquidityUsd ?? 0;
  const state = stableStateFor(observedUsd, targetUsd, liq);
  const deviationPct = observedUsd > 0 ? (observedUsd / targetUsd - 1) * 100 : 0;
  switch (state) {
    case "PEGGED":
      return { usdPrice: observedUsd, state, deviationPct, confidence: 0.98 };
    case "MINOR_DEVIATION":
      return { usdPrice: observedUsd, state, deviationPct, confidence: 0.9 };
    case "STRESSED":
      return { usdPrice: observedUsd, state, deviationPct, confidence: 0.75 };
    case "DEPEGGED":
      return { usdPrice: observedUsd, state, deviationPct, confidence: 0.6 };
    case "UNKNOWN":
    default:
      // Trusted issuer, no usable market observation: $1 prior, low confidence.
      return {
        usdPrice: targetUsd,
        state: "UNKNOWN",
        deviationPct: 0,
        confidence: observedUsd > 0 ? 0.5 : 0.35,
      };
  }
}

/**
 * Clamp used when a trusted stable's pool price is *slightly* off but the
 * peg is intact: for VALUATION (not trading) a pegged stable is shown at the
 * observed price as long as it is inside the minor-deviation band; anything
 * outside is surfaced honestly with its state.
 */
export function valueTrustedStable(
  observedUsd: number,
  opts: { targetUsd?: number; liquidityUsd?: number } = {},
): StablePrice {
  return stableUsdPrice(observedUsd, opts);
}
