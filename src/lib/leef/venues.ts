/**
 * Universal WAX liquidity venues.
 *
 * Alcor remains the CLMM execution source of truth for Alcor legs. Defibox
 * (swap.box) and TacoSwap (swap.taco) are constant-product AMMs whose
 * reserves come from on-chain tables — not scraped website prices.
 *
 * Each venue is an adapter. The route graph does not care which protocol
 * produced an edge; it only quotes "if I put X in, how much comes out?"
 *
 * Status:
 *  - Discovery / ranking quotes: APPROXIMATE (CP math on published reserves)
 *  - Live Alcor legs: EXACT (swapRouter)
 *  - Live Defibox/Taco legs: APPROXIMATE CP + on-chain min-out memo
 */
import { isLeefToken, isWaxToken } from "./amm";
import { LEEF_CONTRACT, LEEF_SYMBOL, WAX_CONTRACT, WAX_SYMBOL } from "./types";

export type VenueId = "alcor" | "defibox" | "taco" | "nefty";

export const DEFIBOX_SWAP = "swap.box";
export const TACO_SWAP = "swap.taco";
export const NEFTY_SWAP = "swap.nefty";
export const ALCOR_SWAP = "swap.alcor";

/** Namespace so Defibox/Taco/Nefty pair ids never collide with Alcor pool ids. */
export const DEFIBOX_ID_BASE = 1_000_000;
export const TACO_ID_BASE = 2_000_000;
/**
 * Nefty pair codes are symbol_codes (up to 7 chars), not numeric ids, so the
 * native handle is a 32-bit FNV-1a hash of the code (see venue-adapters).
 * A high base keeps the full hash range collision-free vs the other venues.
 */
export const NEFTY_ID_BASE = 4_000_000_000;

export function venueOfPoolId(id: number): VenueId {
  if (id >= NEFTY_ID_BASE) return "nefty";
  if (id >= TACO_ID_BASE) return "taco";
  if (id >= DEFIBOX_ID_BASE) return "defibox";
  return "alcor";
}

export function nativePoolId(id: number): number {
  if (id >= NEFTY_ID_BASE) return id - NEFTY_ID_BASE;
  if (id >= TACO_ID_BASE) return id - TACO_ID_BASE;
  if (id >= DEFIBOX_ID_BASE) return id - DEFIBOX_ID_BASE;
  return id;
}

export function swapContractOf(venue: VenueId): string {
  if (venue === "defibox") return DEFIBOX_SWAP;
  if (venue === "taco") return TACO_SWAP;
  if (venue === "nefty") return NEFTY_SWAP;
  return ALCOR_SWAP;
}

export type VenueToken = {
  symbol: string;
  contract: string;
  decimals: number;
  quantity: number;
};

export type VenuePool = {
  venue: VenueId;
  /** Namespaced id used in the route graph. */
  id: number;
  nativeId: number;
  tokenA: VenueToken;
  tokenB: VenueToken;
  /** Alcor-style fee units: 3000 = 0.30%. */
  fee: number;
  feePct: number;
  tvlUsd: number;
  /**
   * Nefty only: the on-chain pair code (e.g. "USDANO"). Nefty swaps key on
   * this code — the memo is `swap:<CODE>,min:<units>` and fresh-row lookups
   * query by it — so it must survive from discovery into quote verification.
   */
  pairCode?: string;
};

/* ------------------------------------------------------------------ */
/* Dust-safe min-outs (waxterminal roundingSafeMin lesson)             */
/* ------------------------------------------------------------------ */

/**
 * waxterminal documents real reverts ("Received lower than minTokenOut: 30,
 * poolId: 7801") when a slippage-adjusted min-out is demanded on a tiny
 * output: pool tick rounding cannot honor sub-precision deltas, so the swap
 * reverts instead of filling. Below this many raw units of expected output,
 * the strict slippage ask is provably unattainable precision noise.
 */
export const DUST_MIN_OUT_RAW_UNITS = 1_000;

/** True when the expected output is dust: > 0 but < DUST_MIN_OUT_RAW_UNITS raw units. */
export function isDustOutput(expectedOut: number, decimals: number): boolean {
  if (!(expectedOut > 0) || !(decimals >= 0)) return false;
  const raw = Math.floor(expectedOut * 10 ** decimals + 1e-9);
  return raw > 0 && raw < DUST_MIN_OUT_RAW_UNITS;
}

/**
 * The min-out we ASK on-chain, in token units, quantized to the token's
 * precision (floored — never demand more than the quote supports).
 *
 * Normal trades: floor(expectedOut × (1 − slippage)) at raw-unit resolution —
 * identical to what the memo builders have always truncated to.
 *
 * Dust trades (< ~1000 raw units): ask exactly 1 raw unit. The strict
 * slippage-adjusted ask is precision noise the pool's rounding cannot honor,
 * so the trade would revert for no economic protection. Tradeoff, gated by
 * size: a dust trade accepts execution at ANY non-zero output instead of
 * reverting — sandwich exposure is bounded to sub-dust value (< 1000 raw
 * units, e.g. < $0.00005 for WAX). The C1 floor checks consume THIS computed
 * ask (swapFloorViolation uses dustSafeMinOut too), so the on-chain memo,
 * the verified leg min-out and the firewall floor are always the same number
 * — the guarantee is lowered by rule, never fabricated.
 */
export function dustSafeMinOut(
  expectedOut: number,
  slippageFrac: number,
  decimals: number,
): number {
  if (!(expectedOut > 0) || !(decimals >= 0)) return 0;
  const scale = 10 ** decimals;
  const expectedRaw = Math.floor(expectedOut * scale + 1e-9);
  if (expectedRaw <= 0) return 0;
  if (expectedRaw < DUST_MIN_OUT_RAW_UNITS) return 1 / scale;
  const slip = Math.min(1, Math.max(0, slippageFrac));
  const strictRaw = Math.floor(expectedOut * (1 - slip) * scale + 1e-9);
  return Math.max(1, strictRaw) / scale;
}

export function tokenOk(t: { symbol: string; contract: string }): boolean {
  if (!t.symbol || !t.contract) return false;
  if (t.symbol.toUpperCase() === LEEF_SYMBOL && !isLeefToken(t)) return false;
  if (t.symbol.toUpperCase() === WAX_SYMBOL && !isWaxToken(t)) return false;
  return true;
}

export function waxQty(p: VenuePool): number {
  if (isWaxToken(p.tokenA)) return p.tokenA.quantity;
  if (isWaxToken(p.tokenB)) return p.tokenB.quantity;
  return 0;
}

/** Rough TVL: 2× WAX side when a WAX reserve exists. */
export function tvlFromWax(waxReserve: number, waxUsd: number): number {
  return waxReserve > 0 && waxUsd > 0 ? waxReserve * 2 * waxUsd : 0;
}

export function parseEosSymbol(raw: unknown): { symbol: string; decimals: number } | null {
  if (typeof raw === "string") {
    const m = raw.match(/^(\d+),([A-Z0-9]+)$/);
    if (m) return { decimals: Number(m[1]), symbol: m[2]! };
    if (/^[A-Z0-9]+$/.test(raw)) return { symbol: raw, decimals: 4 };
  }
  if (raw && typeof raw === "object") {
    const o = raw as { symbol?: unknown; precision?: unknown; decimals?: unknown };
    if (typeof o.symbol === "string") {
      const nested = parseEosSymbol(o.symbol);
      if (nested) return nested;
      return {
        symbol: o.symbol.toUpperCase(),
        decimals: Number(o.precision ?? o.decimals ?? 4) || 4,
      };
    }
  }
  return null;
}

export function parseAssetQty(raw: unknown): { amount: number; symbol: string } | null {
  if (typeof raw === "string") {
    const m = raw.trim().match(/^([\d.]+)\s+([A-Z0-9]+)$/);
    if (!m) return null;
    const amount = Number(m[1]);
    if (!Number.isFinite(amount)) return null;
    return { amount, symbol: m[2]! };
  }
  return null;
}

export { LEEF_CONTRACT, LEEF_SYMBOL, WAX_CONTRACT, WAX_SYMBOL };
