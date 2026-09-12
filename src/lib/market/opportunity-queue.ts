/**
 * Ranked opportunity queue: all producers submit candidates; one action wins.
 * Profit first, inventory maintenance second, controlled volume third.
 */
export type OpportunityIntent = "profit" | "rebalance" | "volume";
export type OpportunityStatus = "candidate" | "rejected" | "selected";

export type TradeOpportunity = {
  id: string;
  intent: OpportunityIntent;
  source: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  notionalUsd: number;
  expectedNetProfitUsd: number;
  expectedNetEdgePct: number;
  confidence: number;
  liquidityUsd: number;
  quoteAgeMs: number;
  inventoryImprovementUsd: number;
  expectedLossUsd: number;
  status: OpportunityStatus;
  reason: string;
};

export type OpportunityBudgets = {
  volumeLossRemainingUsd: number;
  volumeRemainingUsd: number;
  minProfitUsd: number;
  maxQuoteAgeMs: number;
};

const INTENT_PRIORITY: Record<OpportunityIntent, number> = {
  profit: 3,
  rebalance: 2,
  volume: 1,
};

export function opportunityScore(o: TradeOpportunity): number {
  const freshness = Math.max(0, 1 - o.quoteAgeMs / 60_000);
  const liquidity = Math.min(1, Math.log10(Math.max(10, o.liquidityUsd)) / 5);
  const profit = o.expectedNetProfitUsd * 1_000;
  const inventory = o.inventoryImprovementUsd * 20;
  const loss = o.expectedLossUsd * 1_000;
  return (
    INTENT_PRIORITY[o.intent] * 1_000_000 +
    profit +
    inventory -
    loss +
    o.confidence * freshness * liquidity * 100
  );
}

export function rankOpportunities(
  opportunities: TradeOpportunity[],
  budgets: OpportunityBudgets,
): TradeOpportunity[] {
  return opportunities
    .map((o): TradeOpportunity => {
      if (o.quoteAgeMs > budgets.maxQuoteAgeMs) {
        return { ...o, status: "rejected", reason: "STALE_DATA" };
      }
      if (o.intent === "profit" && o.expectedNetProfitUsd < budgets.minProfitUsd) {
        return { ...o, status: "rejected", reason: "INSUFFICIENT_EDGE" };
      }
      if (
        o.intent === "volume" &&
        (o.notionalUsd > budgets.volumeRemainingUsd || o.expectedLossUsd > budgets.volumeLossRemainingUsd)
      ) {
        return { ...o, status: "rejected", reason: "VOLUME_BUDGET" };
      }
      return { ...o, status: "candidate" };
    })
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "candidate" ? -1 : 1;
      return opportunityScore(b) - opportunityScore(a);
    });
}

/** Exactly one selected action, or null (doing nothing is valid). */
export function selectOpportunity(
  opportunities: TradeOpportunity[],
  budgets: OpportunityBudgets,
): TradeOpportunity | null {
  const ranked = rankOpportunities(opportunities, budgets);
  const winner = ranked.find((o) => o.status === "candidate");
  return winner ? { ...winner, status: "selected" } : null;
}
