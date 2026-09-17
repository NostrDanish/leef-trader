import type { LeefSnapshot } from "./types";
import { findToken, type UniverseToken } from "./universe";
import { fetchAlcorRouteCached } from "@/lib/leef/quote-verify";
import { parseAssetAmount, type AlcorRouteQuote } from "@/lib/wallet/alcor-route";
import { platformFeeOn } from "./platform-fee";
import { balanceAmount, canonicalBalanceEntries } from "@/lib/wallet/balances";
import { tokenPrice, type TokenPrice } from "@/lib/market/price-oracle";

/**
 * Priority-ladder rebalancer.
 *
 * The ladder is an ordered list of Alcor token ids ("waxusdc-eth.token", …).
 * Everything the wallet holds is judged against it:
 *
 *  - Dust sweep — any held token NOT on the ladder (worth ≥ minDustUsd) is
 *    sold into the highest-priority ladder token with a route.
 *  - Drift repair — ladder tokens get geometric target weights by rank
 *    (rank 1 heaviest). When a lower-priority token is over target and a
 *    higher one is under, the excess routes upward.
 *
 * Execution quotes come from Alcor's own swap router (exact CLMM math,
 * split routes included), so what the plan shows is what the chain does.
 */

export type Holding = {
  token: UniverseToken;
  amount: number;
  usd: number;
  price: TokenPrice;
};

export type PlannedLeg = {
  from: UniverseToken;
  to: UniverseToken;
  /** Input amount in from-token units. */
  amountIn: number;
  estUsd: number;
  kind: "dust" | "drift";
  reason: string;
  quote?: AlcorRouteQuote;
  quoteError?: string;
};

export type RebalancePlan = {
  legs: PlannedLeg[];
  notes: string[];
  totalUsd: number;
  unroutable: string[];
};

export type RebalanceSettings = {
  /** Seconds between automatic rebalancer checks (desk slider: 5–1800). */
  intervalSec: number;
  /** Dust below this USD value is left alone. */
  minDustUsd: number;
  /** Relative drift from target share that triggers repair, percent. */
  driftPct: number;
  /** Max legs executed per cycle. */
  maxLegs: number;
  /** Single-leg cap as a share of the portfolio, percent. */
  maxLegUsdPct: number;
  /** WAX kept back for CPU/NET resources. */
  reserveWax: number;
  slippage: number;
  maxImpactPct: number;
  /**
   * Poisoned-pool protection: a rebalancer consolidates at fair value — it
   * is NOT an arb desk hunting mispricing. If the venue's executable quote
   * implies an execution price this far from the oracle price (percent, in
   * EITHER direction), the pool is broken, manipulated, or abandoned: skip
   * the leg instead of signing a fantasy quote (or dumping into a trap).
   */
  maxOracleDeviationPct: number;
};

export const DEFAULT_REBALANCE: RebalanceSettings = {
  // 10 minutes: slow enough to never fight the bot's own trades, fast enough
  // to repair real drift. Without this default the scheduler computed
  // `undefined * 1000` and never fired on interval.
  intervalSec: 600,
  minDustUsd: 1,
  driftPct: 15,
  maxLegs: 3,
  maxLegUsdPct: 25,
  reserveWax: 2,
  slippage: 0.8,
  maxImpactPct: 4,
  maxOracleDeviationPct: 35,
};

/**
 * WAX enforces a per-transaction CPU budget; CLMM swaps are CPU-heavy. A
 * sweep bundling many router splits/hops into one atomic tx reverts with
 * tx_cpu_usage_exceeded — and repeated reverts get the ACCOUNT throttled
 * ("exceeded failure limit"). Chunk sweep legs so one transaction carries
 * at most this many router swap actions.
 */
export const MAX_ACTIONS_PER_SWEEP_TX = 4;

/**
 * Greedy pack: group legs into transactions whose total router action count
 * stays under the cap. A single leg too complex for one tx is dropped (its
 * reason is preserved in the `dropped` list).
 */
export function chunkSweepLegs(
  legs: PlannedLeg[],
  maxActions = MAX_ACTIONS_PER_SWEEP_TX,
): { chunks: PlannedLeg[][]; dropped: PlannedLeg[] } {
  const chunks: PlannedLeg[][] = [];
  const dropped: PlannedLeg[] = [];
  let cur: PlannedLeg[] = [];
  let curActions = 0;
  for (const leg of legs) {
    // Every conversion carries its platform-fee action when it's above dust —
    // count it toward the per-tx CPU budget.
    const g = leg.quote
      ? parseAssetAmount(leg.quote.minReceived) || parseAssetAmount(leg.quote.output)
      : 0;
    const feeActions =
      leg.quote && platformFeeOn(g, leg.to) ? 1 : 0;
    const actions = (leg.quote?.swaps.length ?? 1) + feeActions;
    if (actions > maxActions) {
      dropped.push(leg);
      continue;
    }
    if (curActions + actions > maxActions && cur.length > 0) {
      chunks.push(cur);
      cur = [];
      curActions = 0;
    }
    cur.push(leg);
    curActions += actions;
  }
  if (cur.length > 0) chunks.push(cur);
  return { chunks, dropped };
}

/**
 * Deviation of the quote's implied execution price from the oracle price,
 * percent of oracle. Positive = venue pays MORE than fair value (suspicious
 * on a rebalance — usually a poisoned pool, not free money).
 */
export function quoteOracleDeviationPct(leg: PlannedLeg): number | null {
  const out = leg.quote ? parseAssetAmount(leg.quote.output) : 0;
  const inUsd = leg.amountIn * leg.from.usdPrice;
  if (!(out > 0) || !(inUsd > 0) || !(leg.to.usdPrice > 0)) return null;
  const outUsd = out * leg.to.usdPrice;
  return (outUsd / inUsd - 1) * 100;
}

/** Default ladder: bridged USDC first, then WAX, then LEEF. */
export const DEFAULT_LADDER = ["waxusdc-eth.token", "wax-eosio.token", "leef-leefmaincorp"];

/** Geometric target weights by rank (rank 1 = heaviest). */
export function targetShares(ladder: string[]): Map<string, number> {
  const raw = ladder.map((_, i) => Math.pow(0.55, i));
  const sum = raw.reduce((s, x) => s + x, 0) || 1;
  const map = new Map<string, number>();
  ladder.forEach((id, i) => map.set(id, raw[i]! / sum));
  return map;
}

/** Value wallet balances against the authoritative contract-aware oracle. */
export function holdingsFromBalances(
  balances: Record<string, number>,
  universe: UniverseToken[],
  fetchedAt = new Date().toISOString(),
): { holdings: Holding[]; unknown: string[] } {
  const holdings: Holding[] = [];
  const knownKeys = new Set<string>();
  const snapLike = { universe, fetchedAt, waxUsd: 0, leefUsd: 0 };
  for (const { token, amount } of canonicalBalanceEntries(balances, universe)) {
    const id = `${token.symbol}@${token.contract}`;
    knownKeys.add(id.toUpperCase());
    const price = tokenPrice(snapLike, id);
    if (!price || !(price.priceUsd > 0)) continue;
    const usd = amount * price.priceUsd;
    if (usd < 0.005) continue;
    holdings.push({ token, amount, usd, price });
  }
  const unknown = Object.keys(balances).filter((key) => {
    if (!((balances[key] ?? 0) > 0)) return false;
    if (key.includes("@")) return !knownKeys.has(key.toUpperCase());
    // Ignore a safe convenience alias when exactly one universe contract owns
    // the symbol; report genuinely unknown or ambiguous legacy balances.
    return universe.filter((t) => t.symbol === key.toUpperCase()).length !== 1;
  });
  holdings.sort((a, b) => b.usd - a.usd);
  return { holdings, unknown };
}

/** Build the plan synchronously; quotes get attached by `quoteLegs`. */
export function planRebalance(input: {
  holdings: Holding[];
  ladder: string[];
  universe: UniverseToken[];
  settings: RebalanceSettings;
  balances: Record<string, number>;
}): RebalancePlan {
  const { holdings, ladder, settings, balances } = input;
  const { minDustUsd, driftPct, maxLegs, maxLegUsdPct, reserveWax } = settings;
  const notes: string[] = [];
  const unroutable: string[] = [];
  const totalUsd = holdings.reduce((s, h) => s + h.usd, 0);
  const maxLegUsd = Math.max(minDustUsd, (totalUsd * maxLegUsdPct) / 100);
  const shares = targetShares(ladder);
  const ladderSet = new Set(ladder);
  const onLadder = new Map(ladder.map((id, i) => [id, i]));

  const legs: PlannedLeg[] = [];
  const spentByToken = new Map<string, number>();
  const spendable = (t: UniverseToken): number => {
    const bal = balanceAmount(balances, t, input.universe);
    const reserve = t.symbol === "WAX" && t.contract === "eosio.token" ? reserveWax : 0;
    return Math.max(0, bal - reserve - (spentByToken.get(t.alcorId) ?? 0));
  };
  const commitSpend = (t: UniverseToken, amount: number) =>
    spentByToken.set(t.alcorId, (spentByToken.get(t.alcorId) ?? 0) + amount);

  const ladderTarget = (from: UniverseToken, exclude: Set<string>): UniverseToken | null => {
    for (const id of ladder) {
      if (exclude.has(id)) continue;
      const t = findToken(input.universe, id);
      if (t && t.alcorId !== from.alcorId) return t;
    }
    return null;
  };

  // 1) Dust sweep — anything held that's not on the ladder consolidates up.
  for (const h of holdings) {
    if (onLadder.has(h.token.alcorId)) continue;
    if (h.usd < minDustUsd) continue;
    const target = ladderTarget(h.token, new Set());
    if (!target) continue;
    const capAmount = maxLegUsd / Math.max(h.token.usdPrice, 1e-12);
    const amountIn = Math.min(h.amount, spendable(h.token), capAmount);
    if (!(amountIn > 0) || amountIn * h.token.usdPrice < minDustUsd) continue;
    commitSpend(h.token, amountIn);
    legs.push({
      from: h.token,
      to: target,
      amountIn,
      estUsd: amountIn * h.token.usdPrice,
      kind: "dust",
      reason: `Dust sweep · ${h.token.symbol} isn't on the ladder → ${target.symbol} (priority 1)`,
    });
  }

  // 2) Drift repair between ladder tokens (consolidate upward only).
  if (ladder.length > 1 && totalUsd > 0) {
    const rows = ladder.map((id, rank) => {
      const token = findToken(input.universe, id);
      const held = holdings.find((h) => h.token.alcorId === id);
      const usd = held?.usd ?? 0;
      return { id, rank, token, usd, targetUsd: (shares.get(id) ?? 0) * totalUsd };
    });
    const over = rows
      .filter((r) => r.token && r.usd > r.targetUsd * (1 + driftPct / 100) && r.usd - r.targetUsd >= minDustUsd)
      .sort((a, b) => b.usd - b.targetUsd - (a.usd - a.targetUsd));
    const under = rows
      .filter((r) => r.token && r.usd < r.targetUsd * (1 - driftPct / 100) && r.targetUsd - r.usd >= minDustUsd)
      .sort((a, b) => a.rank - b.rank); // fill the highest-priority gap first

    for (const o of over) {
      for (const u of under) {
        if (u.rank >= o.rank) continue; // only consolidate upward
        const legUsd = Math.min(o.usd - o.targetUsd, u.targetUsd - u.usd, maxLegUsd);
        if (legUsd < minDustUsd) continue;
        const from = o.token!;
        const to = u.token!;
        const amountIn = Math.min(legUsd / from.usdPrice, spendable(from));
        if (!(amountIn > 0) || amountIn * from.usdPrice < minDustUsd) continue;
        commitSpend(from, amountIn);
        legs.push({
          from,
          to,
          amountIn,
          estUsd: amountIn * from.usdPrice,
          kind: "drift",
          reason: `Drift repair · ${from.symbol} is ${(o.usd / Math.max(o.targetUsd, 0.01)).toFixed(2)}× target → ${to.symbol} (rank ${u.rank + 1})`,
        });
        o.usd -= amountIn * from.usdPrice;
        u.usd += amountIn * from.usdPrice;
      }
    }
  }

  if (legs.length === 0) notes.push("Portfolio is on-ladder and inside the drift band");
  const capped = legs.slice(0, maxLegs);
  if (legs.length > capped.length) {
    notes.push(`${legs.length - capped.length} legs deferred to the next cycle`);
  }
  return { legs: capped, notes, totalUsd, unroutable };
}

/** Attach live Alcor router quotes with bounded parallelism. */
export async function quoteLegs(
  legs: PlannedLeg[],
  account: string,
  slippage: number,
  maxImpactPct: number,
  concurrency = 3,
): Promise<PlannedLeg[]> {
  const out = new Array<PlannedLeg>(legs.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      const leg = legs[i];
      if (!leg) return;
      try {
        const quote = await fetchAlcorRouteCached({
          tokenInId: leg.from.alcorId,
          tokenOutId: leg.to.alcorId,
          amount: leg.amountIn,
          slippagePct: slippage,
          receiver: account,
          maxHops: 10,
          decimalsIn: leg.from.decimals,
        });
        const impact = parseFloat(quote.priceImpact);
        out[i] = Number.isFinite(impact) && impact > maxImpactPct
          ? { ...leg, quoteError: `Impact ${impact.toFixed(1)}% above ${maxImpactPct}% cap` }
          : { ...leg, quote };
      } catch (err) {
        out[i] = {
          ...leg,
          quoteError: err instanceof Error ? err.message : "No route",
        };
      }
    }
  };
  const workers = Array.from(
    { length: Math.min(Math.max(1, Math.floor(concurrency)), legs.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return out;
}
