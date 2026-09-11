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
};

export type AuxPool = {
  id: number;
  fee: number;
  feePct: number;
  tokenA: TokenRef;
  tokenB: TokenRef;
  tvlUsd: number;
  volume24Usd: number;
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
};

export type SwapRoute = {
  id: string;
  kind: "direct" | "hop";
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
  waxUsd: number;
  leefUsd: number;
  waxPerLeef: number;
  pools: LeefPool[];
  aux: AuxPool[];
  trades: LiveTrade[];
  warning?: string;
};

export const LEEF_CONTRACT = "leefmaincorp";
export const LEEF_SYMBOL = "LEEF";
export const WAX_CONTRACT = "eosio.token";
export const WAX_SYMBOL = "WAX";
