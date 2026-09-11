/**
 * ExecutionRouteOptimizer — size-specific, graph-based routing.
 *
 * Strategies decide WHAT they want (WAX → LEEF, LEEF → WAX, …). This module
 * decides HOW: the executable path that maximises expected net output for
 * THIS exact amount, after fees, impact and hop penalties.
 *
 * Rules:
 *  - Never cache a universal "best pool". Quote the requested size.
 *  - Extra hops must improve net output enough to pay extra fees/impact/risk.
 *  - Splits across parallel books only win when they beat the best single
 *    path by a meaningful margin (extra tx complexity is not free).
 *  - Token identity is contract + symbol. Fake LEEF/WAX never enter the graph.
 */
import { isLeefToken, isWaxToken, quoteConstantProduct } from "./amm";
import { LEEF_CONTRACT, LEEF_SYMBOL, WAX_CONTRACT, WAX_SYMBOL } from "./types";
import type { AuxPool, LeefPool, QuoteLeg, SwapRoute } from "./types";

export const MAX_ROUTE_HOPS = 3;
/** Extra hops must beat a shorter path by this fraction of output. */
export const HOP_IMPROVE_MARGIN = 0.004;
/** Split only if it beats the best single path by this fraction. */
export const SPLIT_IMPROVE_MARGIN = 0.003;
const MAX_IMPACT = 0.35;
const MIN_RESERVE_MULT = 1.5;

type TokenId = string; // SYMBOL@contract

type Edge = {
  poolId: number;
  from: TokenId;
  to: TokenId;
  fromSym: string;
  toSym: string;
  reserveIn: number;
  reserveOut: number;
  fee: number;
  feePct: number;
  tvlUsd: number;
  volume24Usd: number;
  pairName: string;
};

function tokenId(symbol: string, contract: string): TokenId {
  return `${symbol.toUpperCase()}@${contract}`;
}

function leefId(): TokenId {
  return tokenId(LEEF_SYMBOL, LEEF_CONTRACT);
}

function waxId(): TokenId {
  return tokenId(WAX_SYMBOL, WAX_CONTRACT);
}

function parseId(id: TokenId): { symbol: string; contract: string } {
  const i = id.indexOf("@");
  return { symbol: id.slice(0, i), contract: id.slice(i + 1) };
}

function quoteEdge(edge: Edge, amountIn: number): QuoteLeg | null {
  if (!(amountIn > 0) || edge.reserveIn < amountIn * MIN_RESERVE_MULT) return null;
  const q = quoteConstantProduct(amountIn, edge.reserveIn, edge.reserveOut, edge.fee);
  if (q.amountOut <= 0 || q.priceImpact >= MAX_IMPACT) return null;
  return {
    poolId: edge.poolId,
    pairName: edge.pairName,
    tokenIn: edge.fromSym,
    tokenOut: edge.toSym,
    amountIn,
    amountOut: q.amountOut,
    feePct: edge.feePct,
    priceImpact: q.priceImpact,
  };
}

function combineImpact(legs: QuoteLeg[]): number {
  let keep = 1;
  for (const leg of legs) keep *= 1 - leg.priceImpact;
  return Math.max(0, 1 - keep);
}

function routeFromLegs(
  kind: SwapRoute["kind"],
  legs: QuoteLeg[],
  tvlUsd: number,
  volume24Usd: number,
  notes: string[],
): SwapRoute {
  const first = legs[0]!;
  const last = legs[legs.length - 1]!;
  const amountIn = first.amountIn;
  const amountOut = last.amountOut;
  const feePct = 1 - legs.reduce((acc, l) => acc * (1 - l.feePct / 100), 1);
  return {
    id: `${kind}-${legs.map((l) => `${l.poolId}:${l.amountIn.toFixed(6)}`).join("-")}`,
    kind,
    label:
      kind === "direct"
        ? `${first.pairName} · #${first.poolId}`
        : kind === "split"
          ? `Split ${legs.map((l) => `#${l.poolId}`).join("+")}`
          : legs.map((l) => `#${l.poolId} ${l.tokenIn}→${l.tokenOut}`).join(" · "),
    poolIds: legs.map((l) => l.poolId),
    legs,
    amountIn,
    amountOut,
    tokenIn: first.tokenIn,
    tokenOut: last.tokenOut,
    feePct: feePct * 100,
    priceImpact: combineImpact(legs),
    executionPrice: amountIn > 0 ? amountOut / amountIn : 0,
    spotPrice: 0,
    vsBestPct: 0,
    tvlUsd,
    volume24Usd,
    notes,
  };
}

function pushEdge(
  out: Map<TokenId, Edge[]>,
  edge: Edge,
): void {
  const list = out.get(edge.from) ?? [];
  list.push(edge);
  out.set(edge.from, list);
}

/**
 * Build a directed pool graph. Spoofed LEEF/WAX never become nodes.
 */
export function buildRouteGraph(
  pools: LeefPool[],
  aux: AuxPool[],
): Map<TokenId, Edge[]> {
  const g = new Map<TokenId, Edge[]>();

  for (const p of pools) {
    if (!isLeefToken(p.leef)) continue;
    if (p.pair.symbol.toUpperCase() === WAX_SYMBOL && !isWaxToken(p.pair)) continue;
    if (!(p.leef.quantity >= 1_000_000)) continue;
    const a = leefId();
    const b = tokenId(p.pair.symbol, p.pair.contract);
    const name = `LEEF / ${p.pair.symbol}`;
    pushEdge(g, {
      poolId: p.id,
      from: a,
      to: b,
      fromSym: LEEF_SYMBOL,
      toSym: p.pair.symbol.toUpperCase(),
      reserveIn: p.leef.quantity,
      reserveOut: p.pair.quantity,
      fee: p.fee,
      feePct: p.feePct,
      tvlUsd: p.tvlUsd,
      volume24Usd: p.volume24Usd,
      pairName: name,
    });
    pushEdge(g, {
      poolId: p.id,
      from: b,
      to: a,
      fromSym: p.pair.symbol.toUpperCase(),
      toSym: LEEF_SYMBOL,
      reserveIn: p.pair.quantity,
      reserveOut: p.leef.quantity,
      fee: p.fee,
      feePct: p.feePct,
      tvlUsd: p.tvlUsd,
      volume24Usd: p.volume24Usd,
      pairName: name,
    });
  }

  for (const p of aux) {
    if (!p.tokenA.contract || !p.tokenB.contract) continue;
    if (p.tokenA.symbol.toUpperCase() === LEEF_SYMBOL && !isLeefToken(p.tokenA)) continue;
    if (p.tokenB.symbol.toUpperCase() === LEEF_SYMBOL && !isLeefToken(p.tokenB)) continue;
    if (p.tokenA.symbol.toUpperCase() === WAX_SYMBOL && !isWaxToken(p.tokenA)) continue;
    if (p.tokenB.symbol.toUpperCase() === WAX_SYMBOL && !isWaxToken(p.tokenB)) continue;
    if (p.tvlUsd < 5) continue;
    const a = tokenId(p.tokenA.symbol, p.tokenA.contract);
    const b = tokenId(p.tokenB.symbol, p.tokenB.contract);
    const name = `${p.tokenA.symbol} / ${p.tokenB.symbol}`;
    pushEdge(g, {
      poolId: p.id,
      from: a,
      to: b,
      fromSym: p.tokenA.symbol.toUpperCase(),
      toSym: p.tokenB.symbol.toUpperCase(),
      reserveIn: p.tokenA.quantity,
      reserveOut: p.tokenB.quantity,
      fee: p.fee,
      feePct: p.feePct,
      tvlUsd: p.tvlUsd,
      volume24Usd: p.volume24Usd,
      pairName: name,
    });
    pushEdge(g, {
      poolId: p.id,
      from: b,
      to: a,
      fromSym: p.tokenB.symbol.toUpperCase(),
      toSym: p.tokenA.symbol.toUpperCase(),
      reserveIn: p.tokenB.quantity,
      reserveOut: p.tokenA.quantity,
      fee: p.fee,
      feePct: p.feePct,
      tvlUsd: p.tvlUsd,
      volume24Usd: p.volume24Usd,
      pairName: name,
    });
  }
  return g;
}

/** Resolve a user-facing symbol onto a graph node. Strict for LEEF/WAX. */
export function resolveTokenId(
  symbol: string,
  graph: Map<TokenId, Edge[]>,
): TokenId | null {
  const s = symbol.toUpperCase();
  if (s === LEEF_SYMBOL) return leefId();
  if (s === WAX_SYMBOL) return waxId();
  const matches: TokenId[] = [];
  for (const id of graph.keys()) {
    if (parseId(id).symbol === s) matches.push(id);
  }
  if (matches.length === 0) {
    // Isolated tokens still exist as `to` of some edge.
    for (const edges of graph.values()) {
      for (const e of edges) {
        if (e.toSym === s && !matches.includes(e.to)) matches.push(e.to);
      }
    }
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;
  // Prefer the node with the deepest outgoing reserves.
  let best = matches[0]!;
  let bestRes = 0;
  for (const id of matches) {
    const res = (graph.get(id) ?? []).reduce((s2, e) => s2 + e.reserveIn, 0);
    if (res > bestRes) {
      best = id;
      bestRes = res;
    }
  }
  return best;
}

type Path = { legs: QuoteLeg[]; tvl: number; vol: number };

function searchPaths(
  graph: Map<TokenId, Edge[]>,
  from: TokenId,
  to: TokenId,
  amountIn: number,
  maxHops: number,
): Path[] {
  const found: Path[] = [];
  const bestAt = new Map<TokenId, number>();

  type Frame = {
    token: TokenId;
    amount: number;
    hops: number;
    usedPools: Set<number>;
    usedTokens: Set<TokenId>;
    legs: QuoteLeg[];
    tvl: number;
    vol: number;
  };

  const stack: Frame[] = [
    {
      token: from,
      amount: amountIn,
      hops: 0,
      usedPools: new Set(),
      usedTokens: new Set([from]),
      legs: [],
      tvl: 0,
      vol: 0,
    },
  ];

  while (stack.length > 0) {
    const cur = stack.pop()!;
    const prevBest = bestAt.get(cur.token) ?? 0;
    if (cur.amount <= prevBest * 0.999) continue;
    bestAt.set(cur.token, cur.amount);

    if (cur.token === to && cur.legs.length > 0) {
      found.push({ legs: cur.legs, tvl: cur.tvl, vol: cur.vol });
      continue;
    }
    if (cur.hops >= maxHops) continue;

    const edges = graph.get(cur.token) ?? [];
    for (const edge of edges) {
      if (cur.usedPools.has(edge.poolId)) continue;
      if (cur.usedTokens.has(edge.to) && edge.to !== to) continue;
      const leg = quoteEdge(edge, cur.amount);
      if (!leg) continue;
      stack.push({
        token: edge.to,
        amount: leg.amountOut,
        hops: cur.hops + 1,
        usedPools: new Set(cur.usedPools).add(edge.poolId),
        usedTokens: new Set(cur.usedTokens).add(edge.to),
        legs: [...cur.legs, leg],
        tvl: cur.tvl + edge.tvlUsd,
        vol: cur.vol + edge.volume24Usd,
      });
    }
  }
  return found;
}

function scorePath(amountOut: number, hops: number, bestDirectOut: number): number {
  // Extra hops must pay for themselves in output. A 0.4%/hop haircut on the
  // SCORE (not the fill) prefers shorter routes unless the extra hop clearly wins.
  const hopPenalty = 1 - HOP_IMPROVE_MARGIN * Math.max(0, hops - 1);
  let score = amountOut * hopPenalty;
  if (hops > 1 && bestDirectOut > 0 && amountOut < bestDirectOut * (1 + HOP_IMPROVE_MARGIN)) {
    score = 0; // not enough improvement over direct
  }
  return score;
}

function splitDirect(
  graph: Map<TokenId, Edge[]>,
  from: TokenId,
  to: TokenId,
  amountIn: number,
  bestSingleOut: number,
): SwapRoute | null {
  const edges = (graph.get(from) ?? []).filter((e) => e.to === to);
  if (edges.length < 2) return null;

  const quotable = edges
    .map((e) => ({ e, leg: quoteEdge(e, amountIn) }))
    .filter((x): x is { e: Edge; leg: QuoteLeg } => x.leg != null)
    .sort((a, b) => b.leg.amountOut - a.leg.amountOut)
    .slice(0, 3);
  if (quotable.length < 2) return null;

  const ratios: number[][] = [
    quotable.map((q) => q.e.reserveIn), // proportional to depth
    quotable.length === 2 ? [0.7, 0.3] : [0.5, 0.3, 0.2],
    quotable.length === 2 ? [0.5, 0.5] : [0.34, 0.33, 0.33],
  ];

  let best: { legs: QuoteLeg[]; tvl: number; vol: number; out: number } | null = null;
  for (const raw of ratios) {
    const sum = raw.reduce((s, n) => s + n, 0);
    if (!(sum > 0)) continue;
    const legs: QuoteLeg[] = [];
    let tvl = 0;
    let vol = 0;
    let out = 0;
    let ok = true;
    for (let i = 0; i < quotable.length; i++) {
      const slice = amountIn * (raw[i]! / sum);
      if (!(slice > 0)) continue;
      const leg = quoteEdge(quotable[i]!.e, slice);
      if (!leg) {
        ok = false;
        break;
      }
      legs.push(leg);
      tvl += quotable[i]!.e.tvlUsd;
      vol += quotable[i]!.e.volume24Usd;
      out += leg.amountOut;
    }
    if (!ok || legs.length < 2) continue;
    if (!best || out > best.out) best = { legs, tvl, vol, out };
  }
  if (!best || best.out < bestSingleOut * (1 + SPLIT_IMPROVE_MARGIN)) return null;

  // Represent the split as parallel legs; amountIn of the route is the total.
  const notes = [
    `Split ${best.legs.length} books`,
    `+${(((best.out / bestSingleOut) - 1) * 100).toFixed(2)}% vs single`,
  ];
  const route = routeFromLegs("split", best.legs, best.tvl, best.vol, notes);
  route.amountIn = amountIn;
  route.amountOut = best.out;
  route.executionPrice = best.out / amountIn;
  route.tokenIn = parseId(from).symbol;
  route.tokenOut = parseId(to).symbol;
  return route;
}

/**
 * Rank every executable path for this exact size. First row is the best
 * expected fill after hop/split economics. Empty = no trade.
 */
export function rankExecutionRoutes(
  pools: LeefPool[],
  aux: AuxPool[],
  amountIn: number,
  tokenIn: string,
  tokenOut: string,
  maxHops = MAX_ROUTE_HOPS,
): SwapRoute[] {
  if (!(amountIn > 0)) return [];
  if (tokenIn.toUpperCase() === tokenOut.toUpperCase()) return [];
  const graph = buildRouteGraph(pools, aux);
  const from = resolveTokenId(tokenIn, graph);
  const to = resolveTokenId(tokenOut, graph);
  if (!from || !to) return [];

  const paths = searchPaths(graph, from, to, amountIn, maxHops);
  const routes: SwapRoute[] = [];
  const seen = new Set<string>();
  let bestDirectOut = 0;

  for (const p of paths) {
    const hops = p.legs.length;
    const kind: SwapRoute["kind"] = hops === 1 ? "direct" : "hop";
    const notes: string[] = [];
    if (hops === 2) notes.push("Two-hop", "Double fee");
    if (hops >= 3) notes.push(`${hops}-hop`, "Multi fee");
    const route = routeFromLegs(kind, p.legs, p.tvl, p.vol, notes);
    if (seen.has(route.id)) continue;
    seen.add(route.id);
    if (hops === 1) bestDirectOut = Math.max(bestDirectOut, route.amountOut);
    routes.push(route);
  }

  const split = splitDirect(graph, from, to, amountIn, bestDirectOut);
  if (split && !seen.has(split.id)) {
    seen.add(split.id);
    routes.push(split);
  }

  const scored = routes
    .map((r) => ({
      r,
      score: scorePath(r.amountOut, r.kind === "split" ? 1 : r.legs.length, bestDirectOut),
    }))
    .filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || b.r.amountOut - a.r.amountOut);

  const ranked = scored.map((x) => x.r);
  const best = ranked[0]?.amountOut ?? 0;
  for (const r of ranked) {
    r.vsBestPct = best > 0 ? r.amountOut / best - 1 : 0;
  }
  return ranked;
}

/** Best executable route for this exact size, or null (do nothing). */
export function bestExecutionRoute(
  pools: LeefPool[],
  aux: AuxPool[],
  amountIn: number,
  tokenIn: string,
  tokenOut: string,
): SwapRoute | null {
  return rankExecutionRoutes(pools, aux, amountIn, tokenIn, tokenOut)[0] ?? null;
}

/** Alias used by existing desks — same function, size-specific graph search. */
export const compareAllRoutes = rankExecutionRoutes;

export type SplitSlice = { amountIn: number; tokenIn: string; tokenOut: string; poolId: number };

/** Parallel slices for a split route (live batch / paper multi-fill). */
export function splitSlices(route: SwapRoute): SplitSlice[] | null {
  if (route.kind !== "split" || route.legs.length < 2) return null;
  return route.legs.map((l) => ({
    amountIn: l.amountIn,
    tokenIn: l.tokenIn,
    tokenOut: l.tokenOut,
    poolId: l.poolId,
  }));
}
