/**
 * ExecutionRouteOptimizer — size-specific, graph-based routing.
 *
 * Strategies decide WHAT they want (WAX → LEEF, LEEF → WAX, …). This module
 * decides HOW: the executable path that maximises expected net destination
 * output for THIS exact amount.
 *
 * Extra hops are allowed (configurable, default 10) but they must EARN the
 * right: the winner is the highest net destination amount after the quote
 * already nets pool fees + impact. There is no arbitrary "hops are bad"
 * haircut. Splits only win when they beat the best single path by enough to
 * cover extra on-chain actions (SPLIT_IMPROVE_MARGIN).
 *
 * Local quotes use constant-product on published reserves — conservative for
 * Alcor CLMM. Live execution still requotes the winner through Alcor.
 */
import { isLeefToken, isWaxToken, quoteConstantProduct } from "./amm";
import { LEEF_CONTRACT, LEEF_SYMBOL, WAX_CONTRACT, WAX_SYMBOL } from "./types";
import type { AuxPool, LeefPool, QuoteLeg, SwapRoute } from "./types";

/** Hard cap on graph depth. The search decides how many hops actually win. */
export const MAX_ROUTE_HOPS = 10;
/**
 * Split adds extra transfer actions in one tx (CPU). Only take a split when
 * it beats the best single path by this fraction of destination output.
 */
export const SPLIT_IMPROVE_MARGIN = 0.003;
const MAX_IMPACT = 0.35;
const MIN_RESERVE_MULT = 1.5;
/** Cap expansions so 10-hop never brute-forces the whole permutation tree. */
const MAX_EXPANSIONS = 8_000;
const BRANCH_FACTOR = 8;

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

export type RouteSearchStats = {
  expansions: number;
  pruned: number;
  found: number;
};

/**
 * Best-first search with dominance pruning. Extra hops are explored up to
 * maxHops, but a state that arrives at a token with less output than an
 * already-seen state is dropped. Branching is limited to the deepest
 * BRANCH_FACTOR edges so 10-hop never explodes.
 */
function searchPaths(
  graph: Map<TokenId, Edge[]>,
  from: TokenId,
  to: TokenId,
  amountIn: number,
  maxHops: number,
  stats?: RouteSearchStats,
): Path[] {
  const found: Path[] = [];
  const bestAt = new Map<TokenId, number>();
  let expansions = 0;
  let pruned = 0;

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

  const heap: Frame[] = [
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

  while (heap.length > 0) {
    // Best-first: expand the frame with the most intermediate amount.
    let bestI = 0;
    for (let i = 1; i < heap.length; i++) {
      if (heap[i]!.amount > heap[bestI]!.amount) bestI = i;
    }
    const cur = heap.splice(bestI, 1)[0]!;
    expansions += 1;
    if (expansions > MAX_EXPANSIONS) break;

    const prevBest = bestAt.get(cur.token) ?? 0;
    if (cur.amount <= prevBest * 0.9995) {
      pruned += 1;
      continue;
    }
    bestAt.set(cur.token, cur.amount);

    if (cur.token === to && cur.legs.length > 0) {
      found.push({ legs: cur.legs, tvl: cur.tvl, vol: cur.vol });
      continue;
    }
    if (cur.hops >= maxHops) continue;

    const scored: { edge: Edge; leg: QuoteLeg }[] = [];
    for (const edge of graph.get(cur.token) ?? []) {
      if (cur.usedPools.has(edge.poolId)) continue;
      if (cur.usedTokens.has(edge.to) && edge.to !== to) continue;
      const leg = quoteEdge(edge, cur.amount);
      if (!leg) continue;
      scored.push({ edge, leg });
    }
    scored.sort((a, b) => b.leg.amountOut - a.leg.amountOut);
    for (const { edge, leg } of scored.slice(0, BRANCH_FACTOR)) {
      heap.push({
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
  if (stats) {
    stats.expansions = expansions;
    stats.pruned = pruned;
    stats.found = found.length;
  }
  return found;
}

/**
 * Two-book split: golden-section search over share α sent to the better
 * book. Finds the allocation that maximises combined CP output — not a
 * 70/30 / 50/50 ladder.
 */
function splitTwoBooks(
  a: Edge,
  b: Edge,
  amountIn: number,
): { legs: QuoteLeg[]; tvl: number; vol: number; out: number } | null {
  const evalShare = (alpha: number) => {
    const x = amountIn * alpha;
    const y = amountIn - x;
    const la = quoteEdge(a, x);
    const lb = quoteEdge(b, y);
    if (!la || !lb) return null;
    return { legs: [la, lb], tvl: a.tvlUsd + b.tvlUsd, vol: a.volume24Usd + b.volume24Usd, out: la.amountOut + lb.amountOut };
  };

  let lo = 0.05;
  let hi = 0.95;
  const phi = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - phi * (hi - lo);
  let x2 = lo + phi * (hi - lo);
  let f1 = evalShare(x1);
  let f2 = evalShare(x2);
  for (let i = 0; i < 18; i++) {
    const v1 = f1?.out ?? -Infinity;
    const v2 = f2?.out ?? -Infinity;
    if (v1 < v2) {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + phi * (hi - lo);
      f2 = evalShare(x2);
    } else {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - phi * (hi - lo);
      f1 = evalShare(x1);
    }
  }
  const mid = evalShare((lo + hi) / 2);
  const candidates = [f1, f2, mid, evalShare(0.5)].filter(
    (x): x is NonNullable<typeof x> => x != null,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => (c.out > best.out ? c : best));
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

  const ranked = edges
    .map((e) => ({ e, leg: quoteEdge(e, amountIn) }))
    .filter((x): x is { e: Edge; leg: QuoteLeg } => x.leg != null)
    .sort((a, b) => b.leg.amountOut - a.leg.amountOut)
    .slice(0, 3);
  if (ranked.length < 2) return null;

  let best: { legs: QuoteLeg[]; tvl: number; vol: number; out: number } | null = null;
  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const trial = splitTwoBooks(ranked[i]!.e, ranked[j]!.e, amountIn);
      if (trial && (!best || trial.out > best.out)) best = trial;
    }
  }
  if (!best || best.out < bestSingleOut * (1 + SPLIT_IMPROVE_MARGIN)) return null;

  const notes = [
    `Split ${best.legs.length} books`,
    `+${((best.out / bestSingleOut - 1) * 100).toFixed(2)}% vs single`,
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

  const hops = Math.min(MAX_ROUTE_HOPS, Math.max(1, Math.floor(maxHops)));
  const paths = searchPaths(graph, from, to, amountIn, hops);
  const routes: SwapRoute[] = [];
  const seen = new Set<string>();
  let bestDirectOut = 0;

  for (const p of paths) {
    const n = p.legs.length;
    const kind: SwapRoute["kind"] = n === 1 ? "direct" : "hop";
    const notes: string[] = [];
    if (n === 2) notes.push("Two-hop");
    if (n >= 3) notes.push(`${n}-hop`);
    const route = routeFromLegs(kind, p.legs, p.tvl, p.vol, notes);
    if (seen.has(route.id)) continue;
    seen.add(route.id);
    if (n === 1) bestDirectOut = Math.max(bestDirectOut, route.amountOut);
    routes.push(route);
  }

  const split = splitDirect(graph, from, to, amountIn, bestDirectOut);
  if (split && !seen.has(split.id)) {
    seen.add(split.id);
    routes.push(split);
  }

  // Winner = highest destination amount. Extra hops win only if they pay.
  routes.sort((a, b) => b.amountOut - a.amountOut);
  const best = routes[0]?.amountOut ?? 0;
  for (const r of routes) {
    r.vsBestPct = best > 0 ? r.amountOut / best - 1 : 0;
  }
  return routes;
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
