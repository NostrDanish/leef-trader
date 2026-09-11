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

export type VenueId = "alcor" | "defibox" | "taco";

export const DEFIBOX_SWAP = "swap.box";
export const TACO_SWAP = "swap.taco";
export const ALCOR_SWAP = "swap.alcor";

/** Namespace so Defibox/Taco pair ids never collide with Alcor pool ids. */
export const DEFIBOX_ID_BASE = 1_000_000;
export const TACO_ID_BASE = 2_000_000;

export function venueOfPoolId(id: number): VenueId {
  if (id >= TACO_ID_BASE) return "taco";
  if (id >= DEFIBOX_ID_BASE) return "defibox";
  return "alcor";
}

export function nativePoolId(id: number): number {
  if (id >= TACO_ID_BASE) return id - TACO_ID_BASE;
  if (id >= DEFIBOX_ID_BASE) return id - DEFIBOX_ID_BASE;
  return id;
}

export function swapContractOf(venue: VenueId): string {
  if (venue === "defibox") return DEFIBOX_SWAP;
  if (venue === "taco") return TACO_SWAP;
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
};

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
