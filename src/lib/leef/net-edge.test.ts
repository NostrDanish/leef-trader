/**
 * Tests for the economic core: TradeCostModel + NetEdgeEngine + the bot's
 * edge gate. The fixture is a synthetic but mathematically exact LEEF/WAX
 * book — constant-product quotes are computed by the real engine code.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GOALS,
  DEFAULT_RISK,
  evaluateBot,
  type BotInput,
} from "./bot-engine";
import { executionCostPct, realizedVolPerSec, usdPriceOf } from "./cost-model";
import { evaluateEntry, optimizeEntrySize, scoreOpportunity } from "./net-edge";
import type { LeefPool, LeefSnapshot } from "./types";

const WAX_USD = 0.02;

/** One exact CP pool: `waxReserve` WAX against `leefReserve` LEEF, 0.3% fee. */
function mkPool(waxReserve: number, leefReserve: number): LeefPool {
  const pairPerLeef = waxReserve / leefReserve;
  return {
    id: 1159,
    fee: 3000,
    feePct: 0.3,
    leef: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: leefReserve },
    pair: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: waxReserve },
    leefIsA: true,
    tvlUsd: waxReserve * WAX_USD * 2,
    volume24Usd: 50,
    volumeWeekUsd: 300,
    volumeUsdMonth: 1200,
    volumeUsd90: 3600,
    volumeLeef24: 0,
    volumePair24: 0,
    change24: 0,
    changeWeek: 0,
    liquidity: "0",
    pairPerLeef,
    leefPerPair: 1 / pairPerLeef,
    waxPerLeef: pairPerLeef,
    usdPerLeef: pairPerLeef * WAX_USD,
    tickSpacing: 60,
  };
}

function mkSnap(pools: LeefPool[]): LeefSnapshot {
  const waxPerLeef = pools[0]?.waxPerLeef ?? 0;
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    waxUsd: WAX_USD,
    leefUsd: waxPerLeef * WAX_USD,
    waxPerLeef,
    pools,
    aux: [],
    trades: [],
    universe: [],
  };
}

function botInput(over: Partial<BotInput>): BotInput {
  return {
    now: Date.now(),
    snap: mkSnap([mkPool(50_000, 500_000_000)]),
    series: [],
    running: true,
    strategy: "grid",
    goals: { ...DEFAULT_GOALS },
    risk: { ...DEFAULT_RISK },
    position: null,
    gridAnchor: null,
    balances: { WAX: 50 },
    cooldownUntil: 0,
    tradesThisHour: 0,
    sessionRealizedUsd: 0,
    sessionStartEquityUsd: 0,
    ...over,
  };
}

describe("cost model", () => {
  it("prices WAX and LEEF from the snapshot; unknown tokens are unpriceable", () => {
    const snap = mkSnap([mkPool(1000, 1_000_000)]);
    expect(usdPriceOf("WAX", snap)).toBe(WAX_USD);
    expect(usdPriceOf("LEEF", snap)).toBeCloseTo(0.001 * WAX_USD, 12);
    expect(usdPriceOf("NOPE", snap)).toBe(0);
  });

  it("execution cost covers fee + impact exactly once and grows with size", () => {
    const snap = mkSnap([mkPool(1000, 1_000_000)]);
    const small = evaluateEntry({
      snap, tokenIn: "WAX", tokenOut: "LEEF", amountIn: 1,
      expectedGrossPct: 10, minNetEdgePct: 0.1, volPerSec: 0,
    })!;
    const big = evaluateEntry({
      snap, tokenIn: "WAX", tokenOut: "LEEF", amountIn: 20,
      expectedGrossPct: 10, minNetEdgePct: 0.1, volPerSec: 0,
    })!;
    // Both above the 0.3% fee tier, and bigger size pays more impact.
    expect(small.costs.execInPct).toBeGreaterThan(0.3);
    expect(big.costs.execInPct).toBeGreaterThan(small.costs.execInPct);
  });

  it("realizedVolPerSec: 0 until enough prints, then scales with tick spacing", () => {
    expect(realizedVolPerSec([])).toBe(0);
    expect(realizedVolPerSec([{ t: 0, usd: 1 }, { t: 30_000, usd: 1.01 }])).toBe(0);
    // ±1% alternation every 30s → per-tick σ 1% → per-second σ ≈ 0.01/√30.
    const s = Array.from({ length: 30 }, (_, i) => ({
      t: i * 30_000,
      usd: i % 2 === 0 ? 1 : 1.01,
    }));
    expect(realizedVolPerSec(s)).toBeCloseTo(0.01 / Math.sqrt(30), 3);
  });
});

describe("net edge + optimal size", () => {
  it("returns null when no route exists", () => {
    const snap = mkSnap([]);
    snap.waxPerLeef = 0;
    snap.leefUsd = 0;
    expect(
      evaluateEntry({
        snap, tokenIn: "WAX", tokenOut: "LEEF", amountIn: 5,
        expectedGrossPct: 10, minNetEdgePct: 0.1, volPerSec: 0,
      }),
    ).toBeNull();
  });

  it("rejects entries whose costs eat the expected move (do nothing)", () => {
    // Shallow 100 WAX pool: a 2% expected move cannot survive ~10% round-trip cost.
    const snap = mkSnap([mkPool(100, 1_000_000)]);
    const sized = optimizeEntrySize({
      snap, tokenIn: "WAX", tokenOut: "LEEF", expectedGrossPct: 2,
      minNetEdgePct: 0.1, maxIn: 10, volPerSec: 0,
    });
    expect(sized).toBeNull();
  });

  it("finds the interior profit-maximizing size, not the maximum allowed size", () => {
    // 1000 WAX pool, 20% expected move: net profit(size) peaks near 50 WAX,
    // well below the 100 WAX risk cap, because impact accelerates with size.
    const snap = mkSnap([mkPool(1000, 1_000_000)]);
    const sized = optimizeEntrySize({
      snap, tokenIn: "WAX", tokenOut: "LEEF", expectedGrossPct: 20,
      minNetEdgePct: 0.1, maxIn: 100, volPerSec: 0,
    });
    expect(sized).not.toBeNull();
    expect(sized!.best.amountIn).toBeLessThan(100);
    expect(sized!.best.amountIn).toBeGreaterThan(10);
    expect(sized!.best.pass).toBe(true);
    // The chosen size is the most profitable of everything tried.
    const atCap = sized!.tried.find((t) => t.amountIn === 100);
    expect(atCap).toBeDefined();
    expect(sized!.best.netProfitUsd).toBeGreaterThan(atCap!.netProfitUsd);
  });

  it("scores opportunities with explainable factors", () => {
    const snap = mkSnap([mkPool(50_000, 500_000_000)]);
    const v = evaluateEntry({
      snap, tokenIn: "WAX", tokenOut: "LEEF", amountIn: 10,
      expectedGrossPct: 5, minNetEdgePct: 0.1, volPerSec: 0,
    })!;
    const score = scoreOpportunity({
      verdict: v, confidence: 0.8, minNetEdgePct: 0.1,
      maxImpactPct: 3, quoteAgeMs: 2_000, maxQuoteAgeMs: 45_000,
    });
    expect(score.score).toBeGreaterThan(0);
    expect(score.score).toBeLessThanOrEqual(100);
    expect(score.explain).toHaveLength(5);
    expect(score.explain[0]).toMatch(/edge/);
    // A stale quote must crush the score.
    const stale = scoreOpportunity({
      verdict: v, confidence: 0.8, minNetEdgePct: 0.1,
      maxImpactPct: 3, quoteAgeMs: 44_900, maxQuoteAgeMs: 45_000,
    });
    expect(stale.score).toBeLessThan(score.score);
  });
});

describe("bot edge gate (evaluateBot)", () => {
  const anchorAbove = (snap: LeefSnapshot) => snap.leefUsd * 1.1; // grid step-down triggers

  it("buys on a deep book when the step clears all costs", () => {
    const snap = mkSnap([mkPool(50_000, 500_000_000)]);
    const d = evaluateBot(botInput({ snap, gridAnchor: anchorAbove(snap) }));
    expect(d.kind).toBe("buy");
    if (d.kind === "buy") {
      expect(d.amountWax).toBeGreaterThan(0);
      expect(d.amountWax).toBeLessThanOrEqual(DEFAULT_RISK.clipWax);
      expect(d.edge).toBeDefined();
      expect(d.reason).toMatch(/net edge/);
    }
  });

  it("does nothing on a shallow book — the step cannot pay its costs", () => {
    const snap = mkSnap([mkPool(100, 1_000_000)]);
    const d = evaluateBot(botInput({ snap, gridAnchor: anchorAbove(snap) }));
    expect(d.kind).toBe("hold");
    expect(d.reason).toMatch(/clears net edge/);
  });

  it("refuses to act on a stale book", () => {
    const snap = mkSnap([mkPool(50_000, 500_000_000)]);
    snap.fetchedAt = new Date(Date.now() - 120_000).toISOString();
    const d = evaluateBot(botInput({ snap, gridAnchor: anchorAbove(snap) }));
    expect(d.kind).toBe("hold");
    expect(d.reason).toMatch(/old/);
  });
});
