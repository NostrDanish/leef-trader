/**
 * Portfolio next-action planner.
 *
 * The route graph already knows WAX, LEEF, TLM, USDC, TACO, … as nodes.
 * Auto used to only ask "buy LEEF with WAX?". This asks:
 *
 *   Given what I actually hold, what ONE atomic swap (or cycle) is
 *   worth doing right now?
 *
 * After that fill the caller rebuilds the graph. There is no predetermined
 * multi-leg continuation. HOLD (null) is a successful outcome.
 */
import type { LeefSnapshot, SwapRoute } from "./types";
import { usdPriceOf } from "./cost-model";
import {
  bestExecutionRouteOnGraph,
  buildRouteGraph,
  MAX_ROUTE_HOPS,
  rankExecutionRoutesOnGraph,
} from "./route-optimizer";
import { canonicalBalanceEntries } from "@/lib/wallet/balances";

export type NextActionPlan = {
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  route: SwapRoute;
  usdIn: number;
  usdOut: number;
  netUsd: number;
  netPct: number;
  /** path = change inventory; cycle = round-trip same asset. */
  kind: "path" | "cycle";
};

/**
 * Assets the planner may search for a profitable round trip (A→…→A). LEEF
 * included: a LEEF→X→Y→LEEF cycle that grows LEEF is exactly the ecosystem's
 * favorite trade. Every cycle still passes the exact-quote gate with a
 * ≥0 net floor before it can sign — fantasy cycles are refused, not fired.
 */
const CYCLE_ASSETS = new Set(["LEEF", "WAX", "WAXUSDC", "WAXUSDT", "USDT", "PARAUSD"]);

function destinationSymbols(snap: LeefSnapshot): string[] {
  const ranked = [...snap.universe]
    .filter((u) => u.usdPrice > 0 && u.tvlUsd >= 15)
    .sort((a, b) => b.tvlUsd - a.tvlUsd);
  const set = new Set<string>(["WAX", "LEEF"]);
  for (const u of ranked) set.add(u.symbol.toUpperCase());
  return [...set].slice(0, 8);
}

export function planNextAction(
  snap: LeefSnapshot,
  balances: Record<string, number>,
  opts: { minUsd?: number; minNetPct?: number; maxHops?: number } = {},
): NextActionPlan | null {
  const minUsd = Math.max(0, opts.minUsd ?? 0);
  const minNetPct = opts.minNetPct ?? 0;
  const maxHops = Math.min(MAX_ROUTE_HOPS, Math.max(2, opts.maxHops ?? 4));
  const dests = destinationSymbols(snap);
  const graph = buildRouteGraph(snap.pools, snap.aux);
  const entries = canonicalBalanceEntries(balances, snap.universe)
    .map((e) => ({ ...e, usd: e.amount * (usdPriceOf(e.token.symbol, snap) || 0) }))
    .filter((e) => e.usd > 0)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 6);
  let best: NextActionPlan | null = null;

  for (const { token, amount } of entries) {
    const pxIn = usdPriceOf(token.symbol, snap);
    if (!(pxIn > 0) || !(amount > 0)) continue;
    const bagUsd = amount * pxIn;
    if (minUsd > 0 && bagUsd + 1e-12 < minUsd) continue;
    const spendUsd = minUsd > 0 ? Math.min(bagUsd, Math.max(minUsd, bagUsd * 0.25)) : bagUsd * 0.25;
    const spend = spendUsd / pxIn;
    if (!(spend > 0)) continue;

    for (const dest of dests) {
      if (dest === token.symbol) continue;
      const route = bestExecutionRouteOnGraph(graph, spend, token.symbol, dest);
      if (!route) continue;
      const pxOut = usdPriceOf(dest, snap);
      if (!(pxOut > 0)) continue;
      const usdIn = spend * pxIn;
      const usdOut = route.amountOut * pxOut;
      const netUsd = usdOut - usdIn;
      const netPct = usdIn > 0 ? (netUsd / usdIn) * 100 : 0;
      if (netUsd <= 0 || netPct + 1e-12 < minNetPct) continue;
      // Mark-vs-executable guard: a path's "profit" is computed at oracle
      // marks. If the oracle overprices the destination relative to what the
      // route graph would actually pay to SELL it back, the profit exists
      // only in the price marks. Compute the executable exit price from the
      // reverse route; beyond (two-way costs + 3%), the mark is lying and
      // the candidate is rejected. Mark-based inventory improvement remains
      // possible — phantom profit does not.
      const back = bestExecutionRouteOnGraph(graph, route.amountOut, dest, token.symbol);
      if (back && back.amountOut > 0 && route.amountOut > 0) {
        const impliedExitUsd = (back.amountOut * pxIn) / route.amountOut;
        const tolerance =
          1 + (route.feePct + back.feePct) / 100 + (route.priceImpact + back.priceImpact) + 0.03;
        if (pxOut > impliedExitUsd * tolerance) continue;
      }
      if (!best || netUsd > best.netUsd) {
        best = {
          tokenIn: token.symbol,
          tokenOut: dest,
          amountIn: spend,
          route,
          usdIn,
          usdOut,
          netUsd,
          netPct,
          kind: "path",
        };
      }
    }

    if (!CYCLE_ASSETS.has(token.symbol.toUpperCase())) continue;
    const cycle = rankExecutionRoutesOnGraph(
      graph,
      spend,
      token.symbol,
      token.symbol,
      maxHops,
    ).find((r) => r.legs.length >= 2);
    if (cycle) {
      const usdIn = spend * pxIn;
      const usdOut = cycle.amountOut * pxIn;
      const netUsd = usdOut - usdIn;
      const netPct = usdIn > 0 ? (netUsd / usdIn) * 100 : 0;
      if (netUsd > 0 && netPct + 1e-12 >= minNetPct && (!best || netUsd > best.netUsd)) {
        best = {
          tokenIn: token.symbol,
          tokenOut: token.symbol,
          amountIn: spend,
          route: cycle,
          usdIn,
          usdOut,
          netUsd,
          netPct,
          kind: "cycle",
        };
      }
    }
  }
  return best;
}

export type TapeClip = {
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  route: SwapRoute;
  usdIn: number;
  usdOut: number;
  netUsd: number;
  netPct: number;
};

/**
 * Volume-for-LEEF: any held token → LEEF (or LEEF → quote) at a mixed size
 * inside [minUsd, maxUsd]. Prefers profit; accepts zero-loss after LP fees.
 */
export function planLeefTape(
  snap: LeefSnapshot,
  balances: Record<string, number>,
  opts: {
    minUsd: number;
    maxUsd: number;
    maxHops?: number;
    seed?: number;
    maxLossPct?: number;
  },
): TapeClip | null {
  const graph = buildRouteGraph(snap.pools, snap.aux);
  const hops = Math.min(MAX_ROUTE_HOPS, Math.max(1, opts.maxHops ?? 4));
  const maxLoss = Math.max(0, opts.maxLossPct ?? 1.5);
  const seed = opts.seed ?? Date.now();
  const entries = canonicalBalanceEntries(balances, snap.universe)
    .map((e) => ({ ...e, usd: e.amount * (usdPriceOf(e.token.symbol, snap) || 0) }))
    .filter((e) => e.usd > 0)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 8);

  const clips: TapeClip[] = [];
  let i = 0;
  for (const { token, amount, usd } of entries) {
    const px = usdPriceOf(token.symbol, snap);
    if (!(px > 0)) continue;
    const capUsd = Math.min(usd, Math.max(opts.minUsd, opts.maxUsd));
    const loUsd = Math.min(opts.minUsd, capUsd);
    const hiUsd = capUsd;
    if (hiUsd <= 0) continue;
    const r = ((seed + i * 97_331) >>> 0) / 4_294_967_296;
    const ladder = [0, 0.05, 0.12, 0.28, 0.5, 0.75, 1];
    const f = ladder[Math.floor(r * ladder.length) % ladder.length]!;
    const spendUsd = loUsd + (hiUsd - loUsd) * f;
    const spend = Math.min(amount, spendUsd / px);
    if (!(spend > 0)) continue;
    i += 1;

    const tryPair = (from: string, to: string, amt: number) => {
      const route = bestExecutionRouteOnGraph(graph, amt, from, to);
      if (!route) return;
      const pxOut = usdPriceOf(to, snap);
      if (!(pxOut > 0)) return;
      const usdIn = amt * (usdPriceOf(from, snap) || 0);
      const usdOut = route.amountOut * pxOut;
      const netUsd = usdOut - usdIn;
      const netPct = usdIn > 0 ? (netUsd / usdIn) * 100 : 0;
      if (netPct < -maxLoss) return;
      clips.push({
        tokenIn: from,
        tokenOut: to,
        amountIn: amt,
        route,
        usdIn,
        usdOut,
        netUsd,
        netPct,
      });
    };

    if (token.symbol !== "LEEF") tryPair(token.symbol, "LEEF", spend);
    if (token.symbol === "LEEF") {
      for (const q of ["WAX", "WAXUSDC", "USDT", "PARAUSD"]) {
        tryPair("LEEF", q, spend);
      }
    }
  }

  if (clips.length === 0) return null;
  clips.sort((a, b) => {
    const ap = a.netUsd >= 0 ? 1 : 0;
    const bp = b.netUsd >= 0 ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return b.usdIn - a.usdIn;
  });
  return clips[0] ?? null;
}
