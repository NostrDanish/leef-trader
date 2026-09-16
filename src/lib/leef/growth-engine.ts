/**
 * Target Growth Engine — "Don't trade pairs. Grow assets."
 *
 * The user names 1–3 treasures. Each scan asks: given what I hold, what ONE
 * atomic swap or cycle increases those target token counts without destroying
 * portfolio value? HOLD is a successful answer — and the engine always says why.
 *
 * Token count is the objective. Economic value, liquidity, slippage, fees and
 * execution risk are constraints. The existing swap path (fresh Alcor quote,
 * governor, policy, no rebroadcast) remains the execution layer.
 */
import type { LeefSnapshot, SwapRoute } from "./types";
import { usdPriceOf } from "./cost-model";
import {
  buildRouteGraph,
  MAX_ROUTE_HOPS,
  rankExecutionRoutesOnGraph,
} from "./route-optimizer";
import {
  executionProbability,
  freshnessFactor,
  routeComplexity,
} from "./opportunity";
import { canonicalBalanceEntries, markPortfolioUsd } from "@/lib/wallet/balances";

export type GrowthMode = "max" | "balanced" | "compound";

export type GrowthTarget = {
  symbol: string;
  /** 0–100 share of the treasure mix. */
  weight: number;
};

export type TargetAsset = GrowthTarget & {
  amount: number;
  usd: number;
  /** Current share of *target* USD (not whole wallet). */
  sharePct: number;
  gapPct: number;
};

export type TargetPortfolio = {
  targets: TargetAsset[];
  totalTargetUsd: number;
  walletUsd: number;
  /** Non-treasure value the engine may deploy toward the mix. */
  workingCapitalUsd: number;
};

export type GrowthKind = "convert" | "cycle" | "rebalance" | "harvest";

export type GrowthOpportunity = {
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  route: SwapRoute;
  kind: GrowthKind;
  /** Expected change in each target token (spent target is negative). */
  targetDelta: Record<string, number>;
  /** Weighted target-unit growth in USD (primary objective). */
  growthUnits: number;
  /** growthUnits after exec / freshness / impact haircuts. */
  expectedGrowth: number;
  usdIn: number;
  usdOut: number;
  netUsd: number;
  dropPct: number;
  execProb: number;
  growthScore: number;
  explain: string[];
  blocked?: string;
};

export type GrowthPlan = GrowthOpportunity & {
  mode: GrowthMode;
  /** Decision-time context for the exact-quote re-check at sign time. */
  targets: GrowthTarget[];
  weightsPct: Record<string, number>;
  gapPct: Record<string, number>;
};

export type GrowthHold = {
  hold: string;
  explain: string[];
  bestBlocked?: GrowthOpportunity;
};

export const DEFAULT_GROWTH_TARGETS: GrowthTarget[] = [{ symbol: "LEEF", weight: 100 }];

export const GROWTH_MODES: {
  id: GrowthMode;
  label: string;
  hint: string;
  detail: string;
}[] = [
  {
    id: "max",
    label: "Max growth",
    hint: "Aggressive",
    detail: "Deploy working capital whenever a strong opportunity appears. Still HOLDs if the firewall fails.",
  },
  {
    id: "balanced",
    label: "Balanced",
    hint: "Recommended",
    detail: "Grows with ~70% of capital. Reserve stays put. Default — seek edge, don't chase it.",
  },
  {
    id: "compound",
    label: "Compound",
    hint: "Small edges",
    detail: "Conservative. Prefers cycles, mispricings and tiny conversions. Small edges, rebuilt every fill.",
  },
];

type ModePolicy = {
  /** Fraction of a holding eligible this clip. */
  clipPct: number;
  /** Max mark-to-market drop when SPENDING a treasure (harvest / dump). */
  dropCapPct: number;
  /**
   * Max mark-to-market drop when converting working capital INTO a treasure.
   * A fair AMM swap always "drops" by the LP fee (~0.3%); that is the cost of
   * acquiring the bag, not destruction.
   */
  acquireDropCapPct: number;
  /** Required expected growth as a fraction of notional. */
  minGrowthFrac: number;
  minExec: number;
  /** Minimum cycle gain (%) to spend an on-target bag (harvest). */
  harvestMinPct: number;
  maxImpactPct: number;
};

function policyOf(mode: GrowthMode): ModePolicy {
  if (mode === "max") {
    return {
      clipPct: 0.85,
      dropCapPct: 1.5,
      acquireDropCapPct: 2.4,
      minGrowthFrac: 0.00008,
      minExec: 0.45,
      harvestMinPct: 0.35,
      maxImpactPct: 6,
    };
  }
  if (mode === "compound") {
    return {
      clipPct: 0.22,
      dropCapPct: 0.25,
      acquireDropCapPct: 0.85,
      minGrowthFrac: 0.00045,
      minExec: 0.7,
      harvestMinPct: 1.1,
      maxImpactPct: 2,
    };
  }
  return {
    clipPct: 0.55,
    dropCapPct: 0.65,
    acquireDropCapPct: 1.2,
    minGrowthFrac: 0.00022,
    minExec: 0.55,
    harvestMinPct: 0.75,
    maxImpactPct: 3.5,
  };
}

export function normalizeTargets(raw: GrowthTarget[]): GrowthTarget[] {
  const seen = new Set<string>();
  const cleaned: GrowthTarget[] = [];
  for (const t of raw) {
    const symbol = t.symbol.toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    cleaned.push({ symbol, weight: Math.max(0, t.weight) });
    if (cleaned.length >= 5) break;
  }
  const sum = cleaned.reduce((s, t) => s + t.weight, 0);
  if (cleaned.length === 0) return [...DEFAULT_GROWTH_TARGETS];
  if (!(sum > 0)) {
    const w = 100 / cleaned.length;
    return cleaned.map((t) => ({ ...t, weight: w }));
  }
  return cleaned.map((t) => ({ ...t, weight: (t.weight / sum) * 100 }));
}

export function amountOf(balances: Record<string, number>, snap: LeefSnapshot, symbol: string): number {
  const hit = canonicalBalanceEntries(balances, snap.universe).find(
    (e) => e.token.symbol.toUpperCase() === symbol.toUpperCase(),
  );
  return hit?.amount ?? 0;
}

/**
 * Mix is WALLET-relative, not basket-relative: "LEEF 70%" means 70% of the
 * whole portfolio, so a wallet full of USDC shows a huge LEEF gap and the
 * engine wants to deploy that working capital. (Basket-relative share would
 * read 100% LEEF the moment any dust LEEF exists.)
 */
export function snapshotTargets(
  snap: LeefSnapshot,
  balances: Record<string, number>,
  targets: GrowthTarget[],
): TargetAsset[] {
  const norm = normalizeTargets(targets);
  const walletUsd = markPortfolioUsd(snap, balances).totalUsd;
  return norm.map((t) => {
    const amount = amountOf(balances, snap, t.symbol);
    const px = usdPriceOf(t.symbol, snap);
    const usd = amount * (px || 0);
    const sharePct = walletUsd > 0 ? (usd / walletUsd) * 100 : 0;
    return { ...t, amount, usd, sharePct, gapPct: t.weight - sharePct };
  });
}

export function buildTargetPortfolio(
  snap: LeefSnapshot,
  balances: Record<string, number>,
  targets: GrowthTarget[],
): TargetPortfolio {
  const t = snapshotTargets(snap, balances, targets);
  const totalTargetUsd = t.reduce((s, r) => s + r.usd, 0);
  const walletUsd = markPortfolioUsd(snap, balances).totalUsd;
  return {
    targets: t,
    totalTargetUsd,
    walletUsd,
    workingCapitalUsd: Math.max(0, walletUsd - totalTargetUsd),
  };
}

export type TargetUnitPnL = {
  symbol: string;
  start: number;
  now: number;
  delta: number;
  usdNow: number;
  weight: number;
};

export function targetUnitPnl(
  snap: LeefSnapshot,
  balances: Record<string, number>,
  targets: GrowthTarget[],
  start: Record<string, number>,
): TargetUnitPnL[] {
  return snapshotTargets(snap, balances, targets).map((t) => ({
    symbol: t.symbol,
    start: start[t.symbol] ?? t.amount,
    now: t.amount,
    delta: t.amount - (start[t.symbol] ?? t.amount),
    usdNow: t.usd,
    weight: t.weight,
  }));
}

/**
 * Destination shortlist. This caps FINAL DESTINATIONS only — intermediate
 * hops still traverse every edge in the graph, so an obscure TLM pool can
 * still carry WAX → TLM → LEEF even when TLM isn't in this list. Pruning
 * happens after discovery: we rank what we found, never before we looked.
 */
function dests(snap: LeefSnapshot, targets: GrowthTarget[]): string[] {
  const set = new Set<string>(targets.map((t) => t.symbol));
  set.add("WAX");
  const ranked = [...snap.universe]
    .filter((u) => u.usdPrice > 0 && u.tvlUsd >= 20)
    .sort((a, b) => b.tvlUsd - a.tvlUsd);
  for (const u of ranked) set.add(u.symbol.toUpperCase());
  return [...set].slice(0, 14);
}

function fmtTok(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(0);
  if (abs >= 1) return n.toFixed(2);
  if (abs >= 0.0001) return n.toFixed(4);
  return n.toFixed(6);
}

function classify(
  from: string,
  to: string,
  isCycle: boolean,
  targetSet: Set<string>,
): GrowthKind {
  if (isCycle) return targetSet.has(from) ? "harvest" : "cycle";
  if (targetSet.has(from) && targetSet.has(to)) return "rebalance";
  if (targetSet.has(from)) return "harvest"; // one-way spend of a treasure — firewall dumps these
  return "convert";
}

/**
 * Display score 0–100. This NEVER decides — the firewall is the permission
 * layer, expectedGrowth is the ranking key. The score exists so a human can
 * compare opportunities at a glance.
 */
function growthScoreOf(o: {
  expectedGrowth: number;
  usdIn: number;
  execProb: number;
  dropPct: number;
  impactPct: number;
}): number {
  const g = Math.min(1, Math.max(0, o.expectedGrowth / Math.max(0.0001, o.usdIn * 0.01)));
  const drop = Math.min(1, Math.max(0, 1 - o.dropPct / 3));
  const impact = Math.min(1, Math.max(0, 1 - o.impactPct / 8));
  return Math.round(100 * g * o.execProb * drop * impact);
}

function firewall(
  o: {
    kind: GrowthKind;
    from: string;
    to: string;
    expectedGrowth: number;
    need: number;
    dropPct: number;
    execProb: number;
    impactPct: number;
    cycleGainPct: number;
    fromGap: number;
    toGap: number;
    spendingTarget: boolean;
    isCycle: boolean;
    acquiringTreasure: boolean;
  },
  p: ModePolicy,
): string | null {
  const dropCap = o.acquiringTreasure ? p.acquireDropCapPct : p.dropCapPct;
  if (o.dropPct > dropCap + 1e-9) {
    return `portfolio would drop ${o.dropPct.toFixed(2)}% > ${dropCap}% cap (anti-destruction)`;
  }
  if (o.impactPct > p.maxImpactPct + 1e-9) {
    return `impact ${o.impactPct.toFixed(2)}% > ${p.maxImpactPct}%`;
  }
  if (o.execProb + 1e-9 < p.minExec) {
    return `execution probability ${(o.execProb * 100).toFixed(0)}% < required ${(p.minExec * 100).toFixed(0)}%`;
  }
  if (o.expectedGrowth + 1e-12 < o.need) {
    return `net expected growth $${o.expectedGrowth.toFixed(4)} < required $${o.need.toFixed(4)}`;
  }
  if (o.spendingTarget) {
    if (o.isCycle || o.kind === "harvest" || o.kind === "cycle") {
      if (o.cycleGainPct + 1e-9 < p.harvestMinPct) {
        return `harvest ${o.from} cycle +${o.cycleGainPct.toFixed(2)}% < ${p.harvestMinPct}% floor (directional risk)`;
      }
    } else if (o.kind === "rebalance") {
      // Only move treasure → treasure when the destination is more underweight.
      if (o.toGap <= o.fromGap + 0.5) {
        return `${o.from}→${o.to} does not repair mix (gap ${o.fromGap.toFixed(0)} vs ${o.toGap.toFixed(0)})`;
      }
    } else {
      return `won't spend treasure ${o.from} into ${o.to} just to print a larger bag`;
    }
  }
  return null;
}

function formatWhy(best: GrowthOpportunity | undefined, holdReason: string, mode: GrowthMode): string[] {
  if (!best) {
    return [
      "HOLD",
      holdReason,
      `Mode ${mode}. No trade.`,
    ];
  }
  const bits = Object.entries(best.targetDelta).map(([sym, d]) => {
    const sign = d >= 0 ? "+" : "";
    return `${sym} ${sign}${fmtTok(d)}`;
  });
  return [
    "HOLD",
    `Best opportunity: ${best.tokenIn} → ${best.tokenOut} (${best.kind})`,
    `Treasure Δ ${bits.join(" · ") || "none"}`,
    `Expected growth units $${best.expectedGrowth.toFixed(4)} · portfolio ${best.netUsd >= 0 ? "+" : ""}$${best.netUsd.toFixed(4)}`,
    `Fees/impact ${(best.route.priceImpact * 100).toFixed(2)}% · exec ${(best.execProb * 100).toFixed(0)}% · ${best.route.legs.length} hop${best.route.legs.length === 1 ? "" : "s"}`,
    best.blocked ? `Blocked: ${best.blocked}` : holdReason,
    "No trade.",
  ];
}

/** Treasures can include WAX (unlike the pair-bot base list). */
export function listTreasureTokens(snap: LeefSnapshot): string[] {
  const set = new Set<string>(["LEEF", "WAX"]);
  for (const u of snap.universe) {
    if (u.usdPrice > 0 && u.tvlUsd >= 20) set.add(u.symbol.toUpperCase());
  }
  for (const p of snap.pools) {
    if (p.leef.symbol) set.add(p.leef.symbol.toUpperCase());
    if (p.pair.symbol) set.add(p.pair.symbol.toUpperCase());
  }
  const core = ["LEEF", "WAX", "TLM", "WAXUSDC", "WAXUSDT"];
  return [...set].sort((a, b) => {
    const ra = core.indexOf(a);
    const rb = core.indexOf(b);
    if (ra >= 0 || rb >= 0) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
    return a.localeCompare(b);
  });
}

export function hopsForGrowth(mode: GrowthMode, cap: number): number {
  const c = Math.min(MAX_ROUTE_HOPS, Math.max(1, Math.floor(cap || 4)));
  if (mode === "compound") return Math.min(c, 2);
  if (mode === "max") return Math.min(c, 4);
  return Math.min(c, 3);
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
    quoteAgeMs?: number;
    maxQuoteAgeMs?: number;
  },
): GrowthPlan | GrowthHold {
  const targets = normalizeTargets(opts.targets);
  const mode = opts.mode;
  const p = policyOf(mode);
  const hops = hopsForGrowth(mode, opts.maxHops ?? 4);
  const graph = buildRouteGraph(snap.pools, snap.aux);
  const portfolio = buildTargetPortfolio(snap, balances, targets);
  const targetSet = new Set(targets.map((t) => t.symbol));
  const weights = new Map(targets.map((t) => [t.symbol, t.weight / 100]));
  const gaps = new Map(portfolio.targets.map((t) => [t.symbol, t.gapPct]));
  const destinations = dests(snap, targets);
  const quoteAge = opts.quoteAgeMs ?? 0;
  const maxAge = Math.max(1, opts.maxQuoteAgeMs ?? 45_000);
  const fresh = freshnessFactor(quoteAge, maxAge);

  const entries = canonicalBalanceEntries(balances, snap.universe)
    .map((e) => ({ ...e, usd: e.amount * (usdPriceOf(e.token.symbol, snap) || 0) }))
    .filter((e) => e.usd > 0)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 6);

  const picked: { best: GrowthOpportunity | null; blocked: GrowthOpportunity | null } = {
    best: null,
    blocked: null,
  };

  const consider = (from: string, to: string, spend: number, route: SwapRoute): void => {
    const pxIn = usdPriceOf(from, snap);
    const pxOut = usdPriceOf(to, snap);
    if (!(pxIn > 0) || !(pxOut > 0)) return;
    const usdIn = spend * pxIn;
    const usdOut = route.amountOut * pxOut;
    const netUsd = usdOut - usdIn;
    const dropPct = usdIn > 0 ? Math.max(0, (-netUsd / usdIn) * 100) : 100;
    const isCycle = from === to;
    const kind = classify(from, to, isCycle, targetSet);
    const delta: Record<string, number> = {};
    for (const t of targets) delta[t.symbol] = 0;
    if (targetSet.has(from)) delta[from] = (delta[from] ?? 0) - spend;
    if (targetSet.has(to)) delta[to] = (delta[to] ?? 0) + route.amountOut;

    let growthUnits = 0;
    for (const t of targets) {
      const px = usdPriceOf(t.symbol, snap);
      if (!(px > 0)) continue;
      const w = weights.get(t.symbol) ?? 0;
      const gap = (gaps.get(t.symbol) ?? 0) / 100;
      // Underweight treasures count extra; overweight ones still count, just less.
      const tilt = 1 + Math.max(-0.35, Math.min(0.45, gap));
      growthUnits += (delta[t.symbol] ?? 0) * px * w * tilt;
    }

    const cx = routeComplexity(route);
    const execProb = executionProbability({
      hops: cx.hops,
      impactPct: route.priceImpact * 100,
      tvlUsd: route.tvlUsd,
      split: cx.split,
      actions: cx.actions,
    });
    const impactHaircut = Math.min(1, Math.max(0.55, 1 - route.priceImpact / 0.12));
    const expectedGrowth = growthUnits * execProb * fresh * impactHaircut;
    const need = p.minGrowthFrac * Math.max(0.01, usdIn);
    const cycleGainPct = isCycle && spend > 0 ? ((route.amountOut - spend) / spend) * 100 : 0;
    const fromGap = gaps.get(from) ?? 0;
    const toGap = gaps.get(to) ?? 0;
    const blocked = firewall(
      {
        kind,
        from,
        to,
        expectedGrowth,
        need,
        dropPct,
        execProb,
        impactPct: route.priceImpact * 100,
        cycleGainPct,
        fromGap,
        toGap,
        spendingTarget: targetSet.has(from),
        isCycle,
        acquiringTreasure: targetSet.has(to) && !targetSet.has(from),
      },
      p,
    );

    const bits = targets.map((t) => {
      const d = delta[t.symbol] ?? 0;
      const sign = d >= 0 ? "+" : "";
      return `${t.symbol} ${sign}${fmtTok(d)}`;
    });
    const cand: GrowthOpportunity = {
      tokenIn: from,
      tokenOut: to,
      amountIn: spend,
      route,
      kind,
      targetDelta: delta,
      growthUnits,
      expectedGrowth,
      usdIn,
      usdOut,
      netUsd,
      dropPct,
      execProb,
      growthScore: growthScoreOf({
        expectedGrowth,
        usdIn,
        execProb,
        dropPct,
        impactPct: route.priceImpact * 100,
      }),
      explain: [
        `Treasure ${bits.join(" · ")}`,
        `Growth units $${expectedGrowth.toFixed(4)} · portfolio ${netUsd >= 0 ? "+" : ""}$${netUsd.toFixed(4)}`,
        `Route ${route.label} · ${kind} · ${route.legs.length} hop${route.legs.length === 1 ? "" : "s"} · exec ${(execProb * 100).toFixed(0)}%`,
      ],
      blocked: blocked ?? undefined,
    };

    if (blocked) {
      if (!picked.blocked || expectedGrowth > picked.blocked.expectedGrowth) picked.blocked = cand;
      return;
    }
    if (picked.best && expectedGrowth <= picked.best.expectedGrowth) return;
    picked.best = cand;
  };

  let i = 0;
  for (const { token, amount, usd } of entries) {
    const px = usdPriceOf(token.symbol, snap);
    if (!(px > 0)) continue;
    const capUsd = Math.min(usd * p.clipPct, Math.max(opts.minUsd, opts.maxUsd), usd);
    if (opts.minUsd > 0 && usd + 1e-12 < opts.minUsd) continue;
    if (!(capUsd > 0)) continue;
    const lo = Math.min(opts.minUsd > 0 ? opts.minUsd : capUsd * 0.15, capUsd);
    const hi = capUsd;
    const r = (((opts.seed ?? 1) + i * 91_337) >>> 0) / 4_294_967_296;
    const ladder = mode === "compound" ? [0.15, 0.3, 0.5] : mode === "max" ? [0.35, 0.6, 0.85, 1] : [0.2, 0.4, 0.65];
    const f = ladder[Math.floor(r * ladder.length) % ladder.length]!;
    const spendUsd = lo + (hi - lo) * f;
    const spend = Math.min(amount, spendUsd / px);
    if (!(spend > 0)) continue;
    i += 1;

    for (const to of destinations) {
      if (to === token.symbol) continue;
      // Top-2 only matters for treasure destinations — the mix tilt can flip
      // the ranking there. Everything else ranks by raw output anyway.
      const take = targetSet.has(to) ? 2 : 1;
      const routes = rankExecutionRoutesOnGraph(graph, spend, token.symbol, to, hops).slice(0, take);
      for (const route of routes) consider(token.symbol, to, spend, route);
    }

    // Same-asset cycles: working capital (WAX/stables) or a treasure harvest.
    const from = token.symbol;
    if (targetSet.has(from) || from === "WAX" || /USD|USDT|USDC/.test(from)) {
      const cycle = rankExecutionRoutesOnGraph(graph, spend, from, from, hops).find(
        (r) => r.legs.length >= 2,
      );
      if (cycle) consider(from, from, spend, cycle);
    }
  }

  const best = picked.best;
  const bestBlocked = picked.blocked;
  if (!best) {
    const bag = portfolio.targets
      .map((t) => `${t.symbol} ${t.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`)
      .join(" · ");
    const fallback =
      entries.length === 0
        ? "Wallet is empty — nothing to convert into treasure"
        : bestBlocked?.blocked
          ? `${bestBlocked.tokenIn}→${bestBlocked.tokenOut}: ${bestBlocked.blocked}`
          : "No route increased the treasure without destroying value";
    const explain = formatWhy(bestBlocked ?? undefined, fallback, mode);
    return {
      hold: `HOLD · treasure ${bag} · portfolio $${portfolio.walletUsd.toFixed(2)} · ${fallback}`,
      explain,
      bestBlocked: bestBlocked ?? undefined,
    };
  }

  const executeLines = [
    "EXECUTE",
    `Target mix ${targets.map((t) => `${t.symbol} ${t.weight.toFixed(0)}%`).join(" / ")}`,
    `Route: ${best.tokenIn} → ${best.tokenOut} (${best.kind})`,
    ...best.explain,
    `Score ${best.growthScore}/100 · quote ${(fresh * 100).toFixed(0)}% fresh`,
  ];
  return {
    ...best,
    mode,
    targets,
    weightsPct: Object.fromEntries(targets.map((t) => [t.symbol, t.weight])),
    gapPct: Object.fromEntries(portfolio.targets.map((t) => [t.symbol, t.gapPct])),
    explain: executeLines,
  };
}

/**
 * Exact-quote economics gate — the audit step between "the graph liked it"
 * and "capital moves". The candidate's growth thesis is re-run on the
 * venue's exact output for THIS size. If the exact quote no longer grows
 * the treasure (or breaks a firewall rule), the trade dies here.
 *
 *   GRAPH → candidate → EXACT VENUE QUOTE → this gate → firewall → sign
 */
export function verifyGrowthExact(
  plan: GrowthPlan,
  amountIn: number,
  exactOut: number,
  snap: LeefSnapshot,
): { pass: true; growthUnits: number; dropPct: number; reason: string } | { pass: false; reason: string } {
  const p = policyOf(plan.mode);
  const pxIn = usdPriceOf(plan.tokenIn, snap);
  const pxOut = usdPriceOf(plan.tokenOut, snap);
  if (!(pxIn > 0) || !(pxOut > 0)) {
    return { pass: false, reason: "exact gate: lost a price mark" };
  }
  const usdIn = amountIn * pxIn;
  const usdOut = exactOut * pxOut;
  const netUsd = usdOut - usdIn;
  const dropPct = usdIn > 0 ? Math.max(0, (-netUsd / usdIn) * 100) : 100;

  const targets = normalizeTargets(plan.targets);
  const targetSet = new Set(targets.map((t) => t.symbol));
  const isCycle = plan.tokenIn === plan.tokenOut;
  const acquiring = targetSet.has(plan.tokenOut) && !targetSet.has(plan.tokenIn);

  let growthUnits = 0;
  for (const t of targets) {
    const px = usdPriceOf(t.symbol, snap);
    if (!(px > 0)) continue;
    const w = (plan.weightsPct[t.symbol] ?? t.weight) / 100;
    const gap = (plan.gapPct[t.symbol] ?? 0) / 100;
    const tilt = 1 + Math.max(-0.35, Math.min(0.45, gap));
    const delta =
      (t.symbol === plan.tokenIn ? -amountIn : 0) + (t.symbol === plan.tokenOut ? exactOut : 0);
    growthUnits += delta * px * w * tilt;
  }

  const dropCap = acquiring ? p.acquireDropCapPct : p.dropCapPct;
  if (dropPct > dropCap + 1e-9) {
    return {
      pass: false,
      reason: `exact quote: portfolio would drop ${dropPct.toFixed(2)}% > ${dropCap}% cap (anti-destruction)`,
    };
  }
  const need = p.minGrowthFrac * Math.max(0.01, usdIn);
  if (growthUnits + 1e-12 < need) {
    return {
      pass: false,
      reason: `exact quote: treasure growth $${growthUnits.toFixed(4)} < required $${need.toFixed(4)}`,
    };
  }
  if (targetSet.has(plan.tokenIn)) {
    if (isCycle) {
      const gainPct = amountIn > 0 ? ((exactOut - amountIn) / amountIn) * 100 : 0;
      if (gainPct + 1e-9 < p.harvestMinPct) {
        return {
          pass: false,
          reason: `exact quote: harvest ${plan.tokenIn} +${gainPct.toFixed(2)}% < ${p.harvestMinPct}% floor`,
        };
      }
    } else if (plan.kind === "rebalance") {
      const toGap = plan.gapPct[plan.tokenOut] ?? 0;
      const fromGap = plan.gapPct[plan.tokenIn] ?? 0;
      if (toGap <= fromGap + 0.5) {
        return { pass: false, reason: "exact quote: rebalance no longer repairs the mix" };
      }
    } else if (plan.kind !== "harvest") {
      return {
        pass: false,
        reason: `exact quote: won't spend treasure ${plan.tokenIn} into ${plan.tokenOut}`,
      };
    }
  }
  return {
    pass: true,
    growthUnits,
    dropPct,
    reason: `exact quote verified · treasure +$${growthUnits.toFixed(4)} · drop ${dropPct.toFixed(2)}%`,
  };
}
