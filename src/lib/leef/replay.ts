/**
 * Decision replay — run TODAY'S route + gate math against a recorded
 * route-scoped market fixture.
 *
 * This is decision-logic regression, honestly bounded:
 *
 *   ✅ answers "would the current router/gate have decided the same on that
 *     book?" — the exact question that proves an algorithm change helped.
 *   ❌ NOT a P&L backtest. The venue-exact quote at that moment is gone
 *     forever; replay reuses the fixture's recorded venue numbers for the
 *     gate math and recomputes everything local (route search, CP quotes,
 *     cost model, verdicts).
 *
 * A fixture contains only the candidate routes' pools — never a full book.
 */
import { exactSwapVerdict } from "./exact-gate";
import {
  buildRouteGraph,
  rankExecutionRoutesOnGraph,
  routeSignature,
} from "./route-optimizer";
import type { MarketFixture, FixturePool } from "./journal";
import type { AuxPool, LeefPool, LeefSnapshot, SwapRoute } from "./types";
import type { UniverseToken } from "./universe";
import { WAX_SYMBOL, LEEF_CONTRACT, LEEF_SYMBOL } from "./types";

function fixturePoolToLeefPool(p: FixturePool): LeefPool | null {
  const aIsLeef = p.aSym.toUpperCase() === LEEF_SYMBOL && p.aContract === LEEF_CONTRACT;
  const bIsLeef = p.bSym.toUpperCase() === LEEF_SYMBOL && p.bContract === LEEF_CONTRACT;
  if (!aIsLeef && !bIsLeef) return null;
  const leef = aIsLeef
    ? { symbol: LEEF_SYMBOL, contract: LEEF_CONTRACT, decimals: p.aDec, quantity: p.aQty }
    : { symbol: LEEF_SYMBOL, contract: LEEF_CONTRACT, decimals: p.bDec, quantity: p.bQty };
  const pair = aIsLeef
    ? { symbol: p.bSym, contract: p.bContract, decimals: p.bDec, quantity: p.bQty }
    : { symbol: p.aSym, contract: p.aContract, decimals: p.aDec, quantity: p.aQty };
  const pairPerLeef = leef.quantity > 0 ? pair.quantity / leef.quantity : 0;
  return {
    id: p.id,
    fee: Math.round(p.feePct * 10_000),
    feePct: p.feePct,
    leef,
    pair,
    leefIsA: aIsLeef,
    tvlUsd: p.tvlUsd,
    volume24Usd: 0,
    volumeWeekUsd: 0,
    volumeUsdMonth: 0,
    volumeUsd90: 0,
    volumeLeef24: 0,
    volumePair24: 0,
    change24: 0,
    changeWeek: 0,
    liquidity: "0",
    pairPerLeef,
    leefPerPair: pairPerLeef > 0 ? 1 / pairPerLeef : 0,
    waxPerLeef: pair.symbol.toUpperCase() === WAX_SYMBOL ? pairPerLeef : null,
    usdPerLeef: null,
    tickSpacing: 60,
  };
}

function fixturePoolToAux(p: FixturePool): AuxPool {
  return {
    id: p.id,
    fee: Math.round(p.feePct * 10_000),
    feePct: p.feePct,
    tokenA: { symbol: p.aSym, contract: p.aContract, decimals: p.aDec, quantity: p.aQty },
    tokenB: { symbol: p.bSym, contract: p.bContract, decimals: p.bDec, quantity: p.bQty },
    tvlUsd: p.tvlUsd,
    volume24Usd: 0,
    venue: (
      p.venue === "defibox" || p.venue === "taco" || p.venue === "nefty" ? p.venue : "alcor"
    ) as AuxPool["venue"],
  };
}

/** Rebuild a minimal but real LeefSnapshot from a fixture. */
export function snapshotFromFixture(fx: MarketFixture): LeefSnapshot {
  const pools: LeefPool[] = [];
  const aux: AuxPool[] = [];
  for (const p of fx.pools) {
    const asLeef = fixturePoolToLeefPool(p);
    if (asLeef) pools.push(asLeef);
    else aux.push(fixturePoolToAux(p));
  }
  const universe: UniverseToken[] = Object.entries(fx.prices).map(([symbol, usdPrice]) => {
    const fixturePool = fx.pools.find(
      (p) => p.aSym === symbol || p.bSym === symbol,
    );
    const contract =
      fixturePool?.aSym === symbol ? fixturePool.aContract : (fixturePool?.bContract ?? "");
    return {
      symbol,
      contract,
      decimals: 4,
      alcorId: `${symbol.toLowerCase()}-${contract}`,
      poolId: fixturePool?.id ?? 0,
      waxPerToken: fx.waxUsd > 0 ? usdPrice / fx.waxUsd : 0,
      usdPrice,
      tvlUsd: fixturePool?.tvlUsd ?? 0,
      stable: false,
    };
  });
  return {
    source: "live",
    fetchedAt: new Date(fx.ts).toISOString(),
    waxUsd: fx.waxUsd,
    leefUsd: fx.leefUsd,
    waxPerLeef: fx.waxUsd > 0 ? fx.leefUsd / fx.waxUsd : 0,
    pools,
    aux,
    trades: [],
    universe,
  };
}

export type ReplayResult = {
  /** What the recorded gate did. */
  thenPass: boolean | null;
  thenNetPct: number | null;
  /** What the current code does on the same book. */
  nowPass: boolean | null;
  nowNetPct: number | null;
  /** Did the winning route change under today's router? */
  routeChanged: boolean;
  thenRouteSig: string | null;
  nowRouteSig: string | null;
  /** "same" | "flipped" | "route_changed" | "not_replayable" */
  verdict: "same" | "flipped" | "route_changed" | "not_replayable";
  reason: string;
};

/**
 * Replay one fixture. Swap/cycle gate fixtures get a full verdict replay;
 * entry fixtures replay the route ranking (the venue-side entry thesis needs
 * the live router — labeled, never faked).
 */
export function replayFixture(fx: MarketFixture): ReplayResult {
  const snap = snapshotFromFixture(fx);
  const graph = buildRouteGraph(snap.pools, snap.aux);
  const ranked = rankExecutionRoutesOnGraph(graph, fx.amountIn, fx.tokenIn, fx.tokenOut);
  const nowBest: SwapRoute | undefined = ranked[0];
  const nowSig = nowBest ? routeSignature(nowBest) : null;
  const thenSig = fx.candidates[0]?.routeSig ?? null;
  const routeChanged = thenSig != null && nowSig != null && thenSig !== nowSig;

  if (!fx.gate || fx.gate.kind !== "swap") {
    return {
      thenPass: null,
      thenNetPct: null,
      nowPass: null,
      nowNetPct: null,
      routeChanged,
      thenRouteSig: thenSig,
      nowRouteSig: nowSig,
      verdict: routeChanged ? "route_changed" : "same",
      reason: !fx.gate
        ? "execution fixture — route ranking replayed; gate verdict not recorded"
        : `${fx.gate.kind} gate — route ranking replayed; the venue-side thesis needs the live router (never faked)`,
    };
  }

  // Re-run the swap gate's own verdict math with the fixture's recorded
  // venue outputs — the venue quote is historical truth we recorded; the
  // verdict logic is today's code.
  const route: SwapRoute | undefined =
    ranked.find((r) => routeSignature(r) === thenSig) ?? nowBest;
  if (!route) {
    return {
      thenPass: fx.gate.pass,
      thenNetPct: fx.gate.netPct,
      nowPass: null,
      nowNetPct: null,
      routeChanged,
      thenRouteSig: thenSig,
      nowRouteSig: nowSig,
      verdict: "not_replayable",
      reason: "no route on the fixture book",
    };
  }
  const now = exactSwapVerdict({
    snap,
    route,
    amountIn: fx.amountIn,
    expectedOut: fx.gate.expectedOut,
    guaranteedOut: fx.gate.guaranteedOut,
    minNetPct: fx.gate.minNetPct ?? 0,
  });
  const flipped = now.pass !== fx.gate.pass;
  return {
    thenPass: fx.gate.pass,
    thenNetPct: fx.gate.netPct,
    nowPass: now.pass,
    nowNetPct: now.exactNetPct,
    routeChanged,
    thenRouteSig: thenSig,
    nowRouteSig: nowSig,
    verdict: flipped ? "flipped" : routeChanged ? "route_changed" : "same",
    reason: flipped
      ? `verdict flipped: then ${fx.gate.pass ? "PASS" : "FAIL"} → now ${now.pass ? "PASS" : "FAIL"}`
      : routeChanged
        ? `route changed: ${thenSig} → ${nowSig}`
        : "decision identical",
  };
}

export type ReplaySummary = {
  total: number;
  same: number;
  flipped: number;
  routeChanged: number;
  notReplayable: number;
};

export function replayAll(fixtures: MarketFixture[]): { summary: ReplaySummary; results: (ReplayResult & { ts: number })[] } {
  const results = fixtures.map((fx) => ({ ...replayFixture(fx), ts: fx.ts }));
  const summary: ReplaySummary = {
    total: results.length,
    same: results.filter((r) => r.verdict === "same").length,
    flipped: results.filter((r) => r.verdict === "flipped").length,
    routeChanged: results.filter((r) => r.verdict === "route_changed").length,
    notReplayable: results.filter((r) => r.verdict === "not_replayable").length,
  };
  return { summary, results };
}
