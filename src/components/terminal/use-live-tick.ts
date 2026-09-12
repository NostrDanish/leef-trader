import { useEffect, useMemo, useRef, useState } from "react";
import { decorate, scoreSignal, type ChartPoint, type SignalSnap } from "@/lib/leef/indicators";
import { leefLegPoolId, scoreBooks, type BookScore } from "@/lib/leef/route-loss";
import {
  applyBookPrint,
  buildHistory,
  displaySpot,
  displayUnit,
  pickTickPool,
  type LivePrint,
} from "@/lib/leef/tick-engine";
import type { LeefPool, LeefSnapshot, SwapRoute } from "@/lib/leef/types";
import { rankExecutionRoutes } from "@/lib/leef/route-optimizer";
import { routesCached } from "@/lib/market/route-cache";
import { useTerminal } from "@/store/terminal";

export type LiveTickState = {
  pool: LeefPool | undefined;
  unit: string;
  spot: number;
  last: number;
  change: number;
  candles: ChartPoint[];
  prints: LivePrint[];
  signal: SignalSnap;
  high: number;
  low: number;
  books: BookScore[];
  bestBuy: BookScore | null;
  bestSell: BookScore | null;
  routes: SwapRoute[];
  bestRoute: SwapRoute | null;
  swapPoolId: number | null;
};

export function useLiveTick(snap: LeefSnapshot): LiveTickState {
  const tickPoolId = useTerminal((s) => s.tickPoolId);
  const knobs = useTerminal((s) => s.tick);
  const paused = useTerminal((s) => s.tickPaused);
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
  const prints = useMemo<LivePrint[]>(
    () =>
      books.map((b) => ({
        t: Date.parse(snap.fetchedAt) || Date.now(),
        px: b.usdPerMillion,
        pairPx: b.pairPerMillion,
        poolId: b.pool.id,
        pair: b.pool.pair.symbol,
        side: (b.buy?.loss ?? 1) <= (b.sell?.loss ?? 1) ? "buy" : "sell",
        src: "book" as const,
        loss: tokenOut.toUpperCase() === "LEEF" ? (b.buy?.loss ?? null) : (b.sell?.loss ?? null),
        role: b.bestBuy ? "best-buy" : b.bestSell ? "best-sell" : null,
      })),
    [books, snap.fetchedAt, tokenOut],
  );

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

  const [raw, setRaw] = useState(() => [] as ReturnType<typeof buildHistory>);
  const knobsRef = useRef(knobs);
  const poolRef = useRef(pool);
  const rawRef = useRef(raw);
  knobsRef.current = knobs;
  poolRef.current = pool;
  rawRef.current = raw;

  const poolId = pool?.id;
  const bars = knobs.bars;
  const barSec = knobs.barSec;
  const fetchedAt = snap.fetchedAt;
  const source = snap.source;

  useEffect(() => {
    const p = poolRef.current;
    if (!p || poolId == null) return;
    const hist = buildHistory(
      p,
      snap.trades,
      bars,
      barSec,
      Date.now(),
      knobsRef.current.vol,
      snap,
    );
    rawRef.current = hist;
    setRaw(hist);
    // Rebuild when the book identity changes; 30s prints only pin the last close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolId, bars, barSec, source]);

  useEffect(() => {
    const p = poolRef.current;
    if (!p || paused) return;
    const spot = displaySpot(p, snap);
    const stepped = applyBookPrint(
      rawRef.current.length ? rawRef.current : [],
      spot,
      knobsRef.current.barSec,
      Date.parse(fetchedAt) || Date.now(),
      Math.max(p.volume24Usd / 48, 0.01),
    );
    rawRef.current = stepped.candles;
    setRaw(stepped.candles);
    // books/snap used for the tape; pull identity is fetchedAt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchedAt, poolId, paused]);

  const candles = useMemo(() => decorate(raw, knobs), [raw, knobs]);
  const signal = useMemo(() => scoreSignal(candles, knobs), [candles, knobs]);
  const last = candles[candles.length - 1]?.c ?? (pool ? displaySpot(pool, snap) : 0);
  const first = candles[0]?.c ?? last;
  const change = first > 0 ? last / first - 1 : 0;
  const high = candles.reduce((m, c) => Math.max(m, c.h), last || 1);
  const low = candles.reduce((m, c) => Math.min(m, c.l), last || 1);

  return {
    pool,
    unit: pool ? displayUnit(pool) : "USD / 1M",
    spot: pool ? displaySpot(pool, snap) : 0,
    last,
    change,
    candles,
    prints,
    signal,
    high: Number.isFinite(high) ? high : last,
    low: Number.isFinite(low) ? low : last,
    books,
    bestBuy,
    bestSell,
    routes,
    bestRoute,
    swapPoolId,
  };
}
