import type { LeefSnapshot, SwapRoute } from "@/lib/leef/types";
import type { UniverseToken } from "@/lib/leef/universe";
import { requireTradePrice, tokenPrice, type TokenPrice } from "./price-oracle";
import { balanceAmount, balanceForIdentifier, type BalanceBook } from "@/lib/wallet/balances";

export type GovernorMode = "PROFIT" | "VOLUME" | "PROFIT_VOLUME";
export type GovernorState =
  | "RUNNING"
  | "WAITING"
  | "LOW_LIQUIDITY"
  | "ASSET_CONCENTRATION"
  | "REBALANCING"
  | "BLOCKED";

export type InventoryBand = {
  tokenId: string;
  targetPct: number;
  minPct: number;
  maxPct: number;
  reserveUsd: number;
};

export type PortfolioGovernorConfig = {
  mode: GovernorMode;
  /** Reserve held back for each canonical asset. */
  bands: InventoryBand[];
  /** Generic reserve for unconfigured assets. */
  defaultReserveUsd: number;
  /** Max share after a profit trade when no explicit band exists. */
  maxUnbandedConcentrationPct: number;
  /** Minimum pricing confidence for a capital-moving trade. */
  minPriceConfidence: number;
};

export const DEFAULT_GOVERNOR: PortfolioGovernorConfig = {
  mode: "PROFIT_VOLUME",
  bands: [
    { tokenId: "LEEF@leefmaincorp", targetPct: 40, minPct: 10, maxPct: 70, reserveUsd: 1 },
    { tokenId: "WAX@eosio.token", targetPct: 30, minPct: 5, maxPct: 70, reserveUsd: 0.25 },
    { tokenId: "WAXUSDC@eth.token", targetPct: 30, minPct: 0, maxPct: 60, reserveUsd: 1 },
  ],
  defaultReserveUsd: 0,
  maxUnbandedConcentrationPct: 70,
  minPriceConfidence: 0.7,
};

export type PortfolioAssetState = {
  token: UniverseToken;
  amount: number;
  price: TokenPrice;
  usd: number;
  sharePct: number;
  reserveUsd: number;
  deployableUsd: number;
};

export type PortfolioStateView = {
  assets: PortfolioAssetState[];
  totalUsd: number;
  state: GovernorState;
  reason: string;
};

export type TradeProposal = {
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  expectedOut: number;
  expectedNetProfitUsd: number;
  kind: "profit" | "rebalance" | "volume";
  route?: SwapRoute;
};

export type GovernorDecision = {
  allowed: boolean;
  state: GovernorState;
  reason: string;
  requestedAmountIn: number;
  allowedAmountIn: number;
  before: PortfolioStateView;
  after: PortfolioStateView | null;
  reserveImpactUsd: number;
  concentrationImpactPct: number;
};

function bandFor(token: UniverseToken, config: PortfolioGovernorConfig): InventoryBand | undefined {
  const id = `${token.symbol}@${token.contract}`;
  return config.bands.find((b) => b.tokenId.toUpperCase() === id.toUpperCase());
}

export function portfolioState(
  snap: LeefSnapshot,
  balances: BalanceBook,
  config: PortfolioGovernorConfig = DEFAULT_GOVERNOR,
  now = Date.now(),
): PortfolioStateView {
  const raw: Omit<PortfolioAssetState, "sharePct">[] = [];
  for (const token of snap.universe) {
    const amount = balanceAmount(balances, token, snap.universe);
    if (!(amount > 0)) continue;
    const price = tokenPrice(snap, `${token.symbol}@${token.contract}`, now);
    if (!price || !(price.priceUsd > 0)) continue;
    const usd = amount * price.priceUsd;
    if (usd < 0.000001) continue;
    const band = bandFor(token, config);
    const reserveUsd = band?.reserveUsd ?? config.defaultReserveUsd;
    raw.push({
      token,
      amount,
      price,
      usd,
      reserveUsd,
      deployableUsd: Math.max(0, usd - reserveUsd),
    });
  }
  const totalUsd = raw.reduce((s, a) => s + a.usd, 0);
  const assets = raw
    .map((a) => ({ ...a, sharePct: totalUsd > 0 ? (a.usd / totalUsd) * 100 : 0 }))
    .sort((a, b) => b.usd - a.usd);
  const concentrated = assets.find((a) => {
    const band = bandFor(a.token, config);
    const max = band?.maxPct ?? config.maxUnbandedConcentrationPct;
    return a.sharePct > max + 0.001;
  });
  if (concentrated) {
    return {
      assets,
      totalUsd,
      state: "ASSET_CONCENTRATION",
      reason: `${concentrated.token.symbol} is ${concentrated.sharePct.toFixed(1)}% of portfolio — above its operating band`,
    };
  }
  if (assets.length === 0) {
    return { assets, totalUsd, state: "LOW_LIQUIDITY", reason: "No priced inventory" };
  }
  return { assets, totalUsd, state: "RUNNING", reason: "Inventory is inside operating bands" };
}

/** Capital exposed to strategies after operational reserves. */
export function deployableAmount(
  snap: LeefSnapshot,
  balances: BalanceBook,
  tokenId: string,
  config: PortfolioGovernorConfig = DEFAULT_GOVERNOR,
): number {
  const price = tokenPrice(snap, tokenId);
  if (!price || !(price.priceUsd > 0)) return 0;
  const amount = balanceForIdentifier(balances, snap.universe, tokenId);
  const token = snap.universe.find(
    (t) => `${t.symbol}@${t.contract}`.toUpperCase() === price.tokenId.toUpperCase(),
  );
  const reserveUsd = token ? (bandFor(token, config)?.reserveUsd ?? config.defaultReserveUsd) : 0;
  return Math.max(0, amount - reserveUsd / price.priceUsd);
}

function simulatedBalances(
  snap: LeefSnapshot,
  balances: BalanceBook,
  proposal: TradeProposal,
  amountIn: number,
): BalanceBook | null {
  const inPrice = tokenPrice(snap, proposal.tokenIn);
  const outPrice = tokenPrice(snap, proposal.tokenOut);
  if (!inPrice || !outPrice) return null;
  const outAmount = proposal.amountIn > 0
    ? proposal.expectedOut * (amountIn / proposal.amountIn)
    : 0;
  const next = { ...balances };
  const inKey = inPrice.tokenId;
  const outKey = outPrice.tokenId;
  const have = balanceForIdentifier(balances, snap.universe, proposal.tokenIn);
  next[inKey] = Math.max(0, have - amountIn);
  next[outKey] = (next[outKey] ?? balanceForIdentifier(balances, snap.universe, proposal.tokenOut)) + outAmount;
  // Avoid legacy aliases overriding canonical values during simulation.
  delete next[inPrice.symbol];
  delete next[outPrice.symbol];
  return next;
}

/**
 * Simulate a proposal and either allow, reject, or resize it. The governor
 * protects operational reserves and post-trade capability; strategy decides
 * WHAT, but the governor decides how much inventory is actually deployable.
 */
export function governTrade(
  snap: LeefSnapshot,
  balances: BalanceBook,
  proposal: TradeProposal,
  config: PortfolioGovernorConfig = DEFAULT_GOVERNOR,
): GovernorDecision {
  const before = portfolioState(snap, balances, config);
  const inPx = requireTradePrice(snap, proposal.tokenIn);
  const outPx = requireTradePrice(snap, proposal.tokenOut);
  if ("error" in inPx || "error" in outPx) {
    const reason = "error" in inPx ? inPx.error : (outPx as { error: string }).error;
    return {
      allowed: false,
      state: "BLOCKED",
      reason,
      requestedAmountIn: proposal.amountIn,
      allowedAmountIn: 0,
      before,
      after: null,
      reserveImpactUsd: 0,
      concentrationImpactPct: 0,
    };
  }
  if (inPx.confidence < config.minPriceConfidence || outPx.confidence < config.minPriceConfidence) {
    return {
      allowed: false,
      state: "BLOCKED",
      reason: "Price confidence below portfolio-governor minimum",
      requestedAmountIn: proposal.amountIn,
      allowedAmountIn: 0,
      before,
      after: null,
      reserveImpactUsd: 0,
      concentrationImpactPct: 0,
    };
  }
  if (proposal.kind !== "rebalance" && proposal.expectedNetProfitUsd <= 0) {
    return {
      allowed: false,
      state: "WAITING",
      reason: `${proposal.kind} proposal has no positive expected net USD profit`,
      requestedAmountIn: proposal.amountIn,
      allowedAmountIn: 0,
      before,
      after: null,
      reserveImpactUsd: 0,
      concentrationImpactPct: 0,
    };
  }
  const deployable = deployableAmount(snap, balances, proposal.tokenIn, config);
  const allowedAmountIn = Math.min(proposal.amountIn, deployable);
  if (!(allowedAmountIn > 0)) {
    return {
      allowed: false,
      state: "LOW_LIQUIDITY",
      reason: `${inPx.symbol} inventory is reserved for continued operation`,
      requestedAmountIn: proposal.amountIn,
      allowedAmountIn: 0,
      before,
      after: null,
      reserveImpactUsd: proposal.amountIn * inPx.priceUsd,
      concentrationImpactPct: 0,
    };
  }
  const nextBalances = simulatedBalances(snap, balances, proposal, allowedAmountIn);
  const after = nextBalances ? portfolioState(snap, nextBalances, config) : null;
  if (!after) {
    return {
      allowed: false,
      state: "BLOCKED",
      reason: "Could not simulate post-trade portfolio",
      requestedAmountIn: proposal.amountIn,
      allowedAmountIn: 0,
      before,
      after: null,
      reserveImpactUsd: 0,
      concentrationImpactPct: 0,
    };
  }
  const outBefore = before.assets.find((a) => a.price.tokenId === outPx.tokenId)?.sharePct ?? 0;
  const outAfter = after.assets.find((a) => a.price.tokenId === outPx.tokenId)?.sharePct ?? 0;
  const concentrationImpactPct = outAfter - outBefore;
  if (proposal.kind !== "rebalance" && after.state === "ASSET_CONCENTRATION") {
    return {
      allowed: false,
      state: "ASSET_CONCENTRATION",
      reason: `Post-trade simulation rejected: ${after.reason}`,
      requestedAmountIn: proposal.amountIn,
      allowedAmountIn: 0,
      before,
      after,
      reserveImpactUsd: (proposal.amountIn - allowedAmountIn) * inPx.priceUsd,
      concentrationImpactPct,
    };
  }
  return {
    allowed: true,
    state: proposal.kind === "rebalance" ? "REBALANCING" : "RUNNING",
    reason:
      allowedAmountIn + 1e-12 < proposal.amountIn
        ? `Resized to preserve ${inPx.symbol} operating reserve`
        : `Post-trade inventory remains operational`,
    requestedAmountIn: proposal.amountIn,
    allowedAmountIn,
    before,
    after,
    reserveImpactUsd: (proposal.amountIn - allowedAmountIn) * inPx.priceUsd,
    concentrationImpactPct,
  };
}
