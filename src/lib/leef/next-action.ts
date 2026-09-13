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
import { bestExecutionRoute, MAX_ROUTE_HOPS, rankExecutionRoutes } from "./route-optimizer";
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

function destinationSymbols(snap: LeefSnapshot): string[] {
  const set = new Set<string>(["WAX", "LEEF"]);
  for (const u of snap.universe) {
    if (u.usdPrice > 0 && u.tvlUsd >= 15) set.add(u.symbol.toUpperCase());
  }
  return [...set].slice(0, 12);
}

export function planNextAction(
  snap: LeefSnapshot,
  balances: Record<string, number>,
  opts: { minUsd?: number; minNetPct?: number; maxHops?: number } = {},
): NextActionPlan | null {
  const minUsd = Math.max(0, opts.minUsd ?? 0);
  const minNetPct = opts.minNetPct ?? 0;
  const maxHops = Math.min(MAX_ROUTE_HOPS, Math.max(2, opts.maxHops ?? 4));
  const entries = canonicalBalanceEntries(balances, snap.universe);
  const dests = destinationSymbols(snap);
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
      const route = bestExecutionRoute(snap.pools, snap.aux, spend, token.symbol, dest);
      if (!route) continue;
      const pxOut = usdPriceOf(dest, snap);
      if (!(pxOut > 0)) continue;
      const usdIn = spend * pxIn;
      const usdOut = route.amountOut * pxOut;
      const netUsd = usdOut - usdIn;
      const netPct = usdIn > 0 ? (netUsd / usdIn) * 100 : 0;
      if (netUsd <= 0 || netPct + 1e-12 < minNetPct) continue;
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

    const cycle = rankExecutionRoutes(
      snap.pools,
      snap.aux,
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
