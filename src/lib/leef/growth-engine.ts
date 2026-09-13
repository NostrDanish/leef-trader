/**
 * Target Growth Engine — "Don't trade pairs. Grow assets."
 *
 * The user names 1–3 treasures. The bot asks: given what I hold, what ONE
 * atomic swap (or cycle) increases those target token counts without
 * destroying portfolio value? HOLD is a successful answer.
 *
 * Execution still goes through the existing swap path (fresh Alcor quote,
 * governor, policy, no rebroadcast).
 */
import type { LeefSnapshot, SwapRoute } from "./types";
import { usdPriceOf } from "./cost-model";
import {
  bestExecutionRouteOnGraph,
  buildRouteGraph,
  MAX_ROUTE_HOPS,
  rankExecutionRoutesOnGraph,
} from "./route-optimizer";
import { canonicalBalanceEntries, markPortfolioUsd } from "@/lib/wallet/balances";

export type GrowthMode = "max" | "balanced" | "compound";

export type GrowthTarget = {
  symbol: string;
  /** 0–100 share of the treasure mix. */
  weight: number;
};

export const DEFAULT_GROWTH_TARGETS: GrowthTarget[] = [{ symbol: "LEEF", weight: 100 }];

export function normalizeTargets(raw: GrowthTarget[]): GrowthTarget[] {
  const cleaned = raw
    .map((t) => ({ symbol: t.symbol.toUpperCase(), weight: Math.max(0, t.weight) }))
    .filter((t) => t.symbol)
    .slice(0, 3);
  const sum = cleaned.reduce((s, t) => s + t.weight, 0);
  if (cleaned.length === 0) return [...DEFAULT_GROWTH_TARGETS];
  if (!(sum > 0)) {
    const w = 100 / cleaned.length;
    return cleaned.map((t) => ({ ...t, weight: w }));
  }
  return cleaned.map((t) => ({ ...t, weight: (t.weight / sum) * 100 }));
}

export type GrowthPlan = {
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  route: SwapRoute;
  /** Expected change in each target token (can be negative for the spent one). */
  targetDelta: Record<string, number>;
  /** Weighted target-unit growth (primary score). */
  growthUnits: number;
  usdIn: number;
  usdOut: number;
  netUsd: number;
  explain: string[];
};

function amountOf(balances: Record<string, number>, snap: LeefSnapshot, symbol: string): number {
  const hit = canonicalBalanceEntries(balances, snap.universe).find(
    (e) => e.token.symbol.toUpperCase() === symbol.toUpperCase(),
  );
  return hit?.amount ?? 0;
}

function dests(snap: LeefSnapshot, targets: GrowthTarget[]): string[] {
  const set = new Set<string>(targets.map((t) => t.symbol));
  set.add("WAX");
  for (const u of snap.universe) {
    if (u.usdPrice > 0 && u.tvlUsd >= 20) set.add(u.symbol.toUpperCase());
  }
  return [...set].slice(0, 10);
}

function maxValueDropPct(mode: GrowthMode): number {
  if (mode === "max") return 1.5;
  if (mode === "balanced") return 0.6;
  return 0.25;
}

function minGrowthUnits(mode: GrowthMode, notionalUsd: number): number {
  // Tiny WAX edges still count; require a sliver of target-unit growth.
  const floor = mode === "compound" ? 0.0004 : mode === "balanced" ? 0.0002 : 0.00005;
  return floor * Math.max(0.01, notionalUsd);
}

export function planGrowthAction(
  snap: LeefSnapshot,
  balances: Record<string, number>,
  opts: {
    targets: GrowthTarget[];
    mode: GrowthMode;
    minUsd: number;
    maxUsd: number;
    maxHops?: number;
    seed?: number;
  },
): GrowthPlan | { hold: string } {
  const targets = normalizeTargets(opts.targets);
  const graph = buildRouteGraph(snap.pools, snap.aux);
  const hops = Math.min(MAX_ROUTE_HOPS, Math.max(1, opts.maxHops ?? 4));
  const dropCap = maxValueDropPct(opts.mode);
  const before = markPortfolioUsd(snap, balances);
  const entries = canonicalBalanceEntries(balances, snap.universe)
    .map((e) => ({ ...e, usd: e.amount * (usdPriceOf(e.token.symbol, snap) || 0) }))
    .filter((e) => e.usd > 0)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 6);
  const destinations = dests(snap, targets);
  const weights = new Map(targets.map((t) => [t.symbol, t.weight / 100]));

  let best: GrowthPlan | null = null;
  let bestRejected = "No route increased the treasure without destroying value";

  const consider = (from: string, to: string, spend: number, route: SwapRoute) => {
    const pxIn = usdPriceOf(from, snap);
    const pxOut = usdPriceOf(to, snap);
    if (!(pxIn > 0) || !(pxOut > 0)) return;
    const usdIn = spend * pxIn;
    const usdOut = route.amountOut * pxOut;
    const netUsd = usdOut - usdIn;
    const dropPct = usdIn > 0 ? (-netUsd / usdIn) * 100 : 100;
    if (dropPct > dropCap + 1e-9) {
      bestRejected = `Best path ${from}→${to} would drop value ${dropPct.toFixed(2)}% > ${dropCap}% cap`;
      return;
    }
    const delta: Record<string, number> = {};
    for (const t of targets) delta[t.symbol] = 0;
    if (weights.has(from)) delta[from] = (delta[from] ?? 0) - spend;
    if (weights.has(to)) delta[to] = (delta[to] ?? 0) + route.amountOut;

    let growthUnits = 0;
    for (const t of targets) {
      const px = usdPriceOf(t.symbol, snap);
      if (!(px > 0)) continue;
      growthUnits += (delta[t.symbol] ?? 0) * px * (weights.get(t.symbol) ?? 0);
    }
    const need = minGrowthUnits(opts.mode, usdIn);
    if (growthUnits < need) {
      bestRejected = `${from}→${to}: treasure +$${growthUnits.toFixed(4)} < required +$${need.toFixed(4)}`;
      return;
    }
    if (best && growthUnits <= best.growthUnits) return;
    const bits = targets.map((t) => {
      const d = delta[t.symbol] ?? 0;
      const sign = d >= 0 ? "+" : "";
      return `${t.symbol} ${sign}${d.toFixed(d > 1000 ? 0 : 4)}`;
    });
    best = {
      tokenIn: from,
      tokenOut: to,
      amountIn: spend,
      route,
      targetDelta: delta,
      growthUnits,
      usdIn,
      usdOut,
      netUsd,
      explain: [
        `Treasure ${bits.join(" · ")}`,
        `Growth units $${growthUnits.toFixed(4)} · portfolio ${netUsd >= 0 ? "+" : ""}$${netUsd.toFixed(4)}`,
        `Route ${route.label} · ${route.legs.length} hop${route.legs.length === 1 ? "" : "s"}`,
      ],
    };
  };

  let i = 0;
  for (const { token, amount, usd } of entries) {
    const px = usdPriceOf(token.symbol, snap);
    if (!(px > 0)) continue;
    const capUsd = Math.min(usd, Math.max(opts.minUsd, opts.maxUsd));
    if (opts.minUsd > 0 && usd + 1e-12 < opts.minUsd) continue;
    const lo = Math.min(opts.minUsd, capUsd);
    const hi = capUsd;
    const r = (((opts.seed ?? Date.now()) + i * 91_337) >>> 0) / 4_294_967_296;
    const f = [0.12, 0.25, 0.4, 0.6, 0.85][Math.floor(r * 5) % 5]!;
    const spendUsd = lo + (hi - lo) * f;
    const spend = Math.min(amount, spendUsd / px);
    if (!(spend > 0)) continue;
    i += 1;

    for (const to of destinations) {
      if (to === token.symbol) continue;
      const route = bestExecutionRouteOnGraph(graph, spend, token.symbol, to);
      if (route) consider(token.symbol, to, spend, route);
    }

    if (weights.has(token.symbol) || token.symbol === "WAX") {
      const cycle = rankExecutionRoutesOnGraph(
        graph,
        spend,
        token.symbol,
        token.symbol,
        hops,
      ).find((r) => r.legs.length >= 2);
      if (cycle) consider(token.symbol, token.symbol, spend, cycle);
    }
  }

  if (!best) {
    const bag = targets
      .map((t) => `${t.symbol} ${amountOf(balances, snap, t.symbol).toLocaleString()}`)
      .join(" · ");
    return {
      hold: `HOLD · treasure ${bag} · portfolio $${before.totalUsd.toFixed(2)} · ${bestRejected}`,
    };
  }
  return best;
}

export function snapshotTargets(
  snap: LeefSnapshot,
  balances: Record<string, number>,
  targets: GrowthTarget[],
): { symbol: string; amount: number; usd: number; weight: number }[] {
  return normalizeTargets(targets).map((t) => {
    const amount = amountOf(balances, snap, t.symbol);
    const px = usdPriceOf(t.symbol, snap);
    return { symbol: t.symbol, amount, usd: amount * (px || 0), weight: t.weight };
  });
}
