export type TokenRef = {
  symbol: string;
  contract: string;
  decimals: number;
  quantity: number;
};

export type LeefPool = {
  id: number;
  fee: number;
  feePct: number;
  leef: TokenRef;
  pair: TokenRef;
  leefIsA: boolean;
  tvlUsd: number;
  volume24Usd: number;
  volumeWeekUsd: number;
  volumeUsdMonth: number;
  volumeUsd90: number;
  volumeLeef24: number;
  volumePair24: number;
  change24: number;
  changeWeek: number;
  liquidity: string;
  /** Pair units per 1 LEEF (spot). */
  pairPerLeef: number;
  /** LEEF per 1 pair token (spot). */
  leefPerPair: number;
  /** WAX per 1 LEEF when a conversion exists. */
  waxPerLeef: number | null;
  usdPerLeef: number | null;
  firstSeenAt?: string;
  sqrtPriceX64?: string;
  /** Concentrated-liquidity tick spacing (60 = 0.3% tier, 200 = 1% tier). */
  tickSpacing: number;
};

export type AuxPool = {
  id: number;
  fee: number;
  feePct: number;
  tokenA: TokenRef;
  tokenB: TokenRef;
  tvlUsd: number;
  volume24Usd: number;
  /** Liquidity venue. Omitted = Alcor (legacy aux books). */
  venue?: "alcor" | "defibox" | "taco" | "nefty";
  /** Alcor's quoted spot price (B per 1 A) — CLMM-aware, unlike raw reserves. */
  priceA?: number;
  /** Alcor's quoted spot price (A per 1 B). */
  priceB?: number;
  sqrtPriceX64?: string;
  /**
   * Alcor CLMM active liquidity (raw string). With `sqrtPriceX64` it yields
   * V3 virtual reserves; absent/"0" (Defibox/Taco) → raw-reserve quoting.
   */
  liquidity?: string;
};

export type LiveTrade = {
  poolId: number;
  pair: string;
  time: string;
  timestamp: number;
  type: "buy" | "sell" | "liq";
  priceWax: number;
  amountLeef: number;
  amountPair: number;
  pairSymbol: string;
  txHash: string;
  usdVolume: number;
  account: string;
};

export type QuoteLeg = {
  poolId: number;
  pairName: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  amountOut: number;
  feePct: number;
  priceImpact: number;
  venue?: "alcor" | "defibox" | "taco" | "nefty";
};

export type SwapRoute = {
  id: string;
  kind: "direct" | "hop" | "split";
  label: string;
  poolIds: number[];
  legs: QuoteLeg[];
  amountIn: number;
  amountOut: number;
  tokenIn: string;
  tokenOut: string;
  feePct: number;
  priceImpact: number;
  executionPrice: number;
  spotPrice: number;
  vsBestPct: number;
  tvlUsd: number;
  volume24Usd: number;
  notes: string[];
};

export type TradeBadge =
  | "best-buy"
  | "best-sell"
  | "deepest"
  | "most-traded"
  | "mispriced"
  | "thin";

export type RankedPool = LeefPool & {
  tradeScore: number;
  impactBuy10Wax: number | null;
  impactSell1mLeef: number | null;
  badges: TradeBadge[];
  waxPerMillionLeef: number | null;
  vsMedianWaxPct: number | null;
  turnover: number;
  feeApyPct: number;
};

export type SnapshotSource = "live" | "fallback";

export type LeefSnapshot = {
  source: SnapshotSource;
  fetchedAt: string;
  /**
   * When on-chain pool state (swap.alcor table reads) last patched this
   * snapshot's prices — the block-driven heartbeat between API pulls.
   */
  spotAt?: string;
  waxUsd: number;
  leefUsd: number;
  waxPerLeef: number;
  /**
   * WAX/USD oracle quality: how many independent WAX/stable observations
   * produced this price and how tightly they agree. 0 confidence = unknown.
   */
  waxConfidence?: number;
  waxSources?: number;
  waxDispersionPct?: number;
  pools: LeefPool[];
  aux: AuxPool[];
  trades: LiveTrade[];
  /** Priced tradable token universe on Alcor (for the rebalancer). */
  universe: import("./universe").UniverseToken[];
  /** Defibox + TacoSwap + Nefty CP books (namespaced ids). Empty when discovery failed. */
  venues?: import("./venues").VenuePool[];
  warning?: string;
};

/**
 * ms epoch of the freshest book content: the API pull (`fetchedAt`) OR a
 * later on-chain spot patch (`spotAt`). Hot pools re-read from swap.alcor
 * between API pulls must NOT score as stale just because the last full API
 * pull is old (freshness bug F0).
 *
 * NOTE: freshness is SNAPSHOT-wide — a hot-pool-only patch marks the whole
 * snapshot fresh. That is safe because the per-pool gates bound it: spread
 * arb requires BOTH legs to be hot/fresh pools (recently table-read), the
 * volume gate needs per-pool third-party flow, and the exact-quote gate
 * re-reads the involved rows from chain before signing. Stale aux books can
 * never carry a trade on a "fresh" timestamp alone.
 */
export function snapFreshAtMs(snap: Pick<LeefSnapshot, "fetchedAt" | "spotAt">): number {
  const fetched = Date.parse(snap.fetchedAt);
  const spot = snap.spotAt ? Date.parse(snap.spotAt) : NaN;
  if (!Number.isFinite(fetched)) return spot;
  return Number.isFinite(spot) ? Math.max(fetched, spot) : fetched;
}

export const LEEF_CONTRACT = "leefmaincorp";
export const LEEF_SYMBOL = "LEEF";
export const WAX_CONTRACT = "eosio.token";
export const WAX_SYMBOL = "WAX";
