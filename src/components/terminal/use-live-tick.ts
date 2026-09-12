import { useMemo } from "react";
import { pickTickPool } from "@/lib/leef/tick-engine";
import { leefLegPoolId, scoreBooks, type BookScore } from "@/lib/leef/route-loss";
import type { LeefPool, LeefSnapshot, SwapRoute } from "@/lib/leef/types";
import { rankExecutionRoutes } from "@/lib/leef/route-optimizer";
import { routesCached } from "@/lib/market/route-cache";
import { useTerminal } from "@/store/terminal";

/**
 * Lightweight authoritative market view for the terminal.
 *
 * No synthetic candles, seeded noise, moving-price animation, indicator
 * decoration or pause/play state. This computes only real pool comparisons
 * and size-specific routes from the MarketEngine snapshot.
 */
export type LiveTickState = {
  pool: LeefPool | undefined;
  books: BookScore[];
  bestBuy: BookScore | null;
  bestSell: BookScore | null;
  routes: SwapRoute[];
  bestRoute: SwapRoute | null;
  swapPoolId: number | null;
};

export function useLiveTick(snap: LeefSnapshot): LiveTickState {
  const tickPoolId = useTerminal((s) => s.tickPoolId);
  const tokenIn = useTerminal((s) => s.tokenIn);
  const tokenOut = useTerminal((s) => s.tokenOut);
  const amountIn = useTerminal((s) => s.amountIn);
  const pool = useMemo(
    () => pickTickPool(snap.pools, tickPoolId),
    [snap.pools, tickPoolId],
  );
  const books = useMemo(() => scoreBooks(snap), [snap]);
  const bestBuy = books.find((b) => b.bestBuy) ?? null;
  const bestSell = books.find((b) => b.bestSell) ?? null;
  const amount = Number(amountIn) || 0;
  const routePoolIds = useMemo(
    () => [...snap.pools.map((p) => p.id), ...snap.aux.map((p) => p.id)],
    [snap.pools, snap.aux],
  );
  const routes = useMemo(
    () =>
      routesCached(
        () => rankExecutionRoutes(snap.pools, snap.aux, amount, tokenIn, tokenOut),
        {
          key: `terminal:${tokenIn.toUpperCase()}>${tokenOut.toUpperCase()}`,
          poolIds: routePoolIds,
          inputsKey: amount.toPrecision(12),
        },
      ),
    [snap.pools, snap.aux, amount, tokenIn, tokenOut, routePoolIds],
  );
  const bestRoute = routes[0] ?? null;
  const swapPoolId = bestRoute ? leefLegPoolId(bestRoute) : (bestBuy?.pool.id ?? null);
  return { pool, books, bestBuy, bestSell, routes, bestRoute, swapPoolId };
}
