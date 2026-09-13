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
  hopsForStrategy,
  pickClipInBand,
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
  const leefUsd = waxPerLeef * WAX_USD;
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    waxUsd: WAX_USD,
    leefUsd,
    waxPerLeef,
    pools,
    aux: [],
    trades: [],
    // The oracle resolves WAX/LEEF (and balances) through the universe — a
    // test book without it fails closed exactly like production would.
    universe: [
      {
        symbol: "WAX",
        contract: "eosio.token",
        decimals: 8,
        alcorId: "wax-eosio.token",
        poolId: 0,
        waxPerToken: 1,
        usdPrice: WAX_USD,
        tvlUsd: 1_000_000,
        stable: false,
      },
      {
        symbol: "LEEF",
        contract: "leefmaincorp",
        decimals: 4,
        alcorId: "leef-leefmaincorp",
        poolId: pools[0]?.id ?? 1159,
        waxPerToken: waxPerLeef,
        usdPrice: leefUsd,
        tvlUsd: pools[0]?.tvlUsd ?? 0,
        stable: false,
      },
    ],
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

describe("clip band + hops", () => {
  it("never always picks the max — mixes sizes inside [min, max]", () => {
    const sizes = new Set<number>();
    for (let i = 0; i < 40; i++) sizes.add(Number(pickClipInBand(1, 10, i * 997).toFixed(6)));
    expect(sizes.size).toBeGreaterThan(2);
    for (const s of sizes) {
      expect(s).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(s).toBeLessThanOrEqual(10 + 1e-9);
    }
  });
  it("caps hops at the user setting and stays below 10 unless asked", () => {
    expect(hopsForStrategy("volume", 4)).toBeLessThanOrEqual(4);
    expect(hopsForStrategy("signal", 3)).toBeLessThanOrEqual(3);
    expect(hopsForStrategy("unleashed", 10)).toBeLessThanOrEqual(10);
    expect(hopsForStrategy("volume-x", 2)).toBeLessThanOrEqual(2);
  });
});

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
      minNetEdgePct: 0.1, minIn: 0.1, maxIn: 10, volPerSec: 0,
    });
    expect(sized).toBeNull();
  });

  it("finds the interior profit-maximizing size, not the maximum allowed size", () => {
    // 1000 WAX pool, 20% expected move: net profit(size) peaks near 50 WAX,
    // well below the 100 WAX risk cap, because impact accelerates with size.
    const snap = mkSnap([mkPool(1000, 1_000_000)]);
    const sized = optimizeEntrySize({
      snap, tokenIn: "WAX", tokenOut: "LEEF", expectedGrossPct: 20,
      minNetEdgePct: 0.1, minIn: 0.1, maxIn: 100, volPerSec: 0,
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

  it("never sizes below the clip floor or above the max", () => {
    const snap = mkSnap([mkPool(50_000, 500_000_000)]);
    const sized = optimizeEntrySize({
      snap, tokenIn: "WAX", tokenOut: "LEEF", expectedGrossPct: 8,
      minNetEdgePct: 0.1, minIn: 5, maxIn: 40, volPerSec: 0,
    });
    expect(sized).not.toBeNull();
    expect(sized!.best.amountIn).toBeGreaterThanOrEqual(5 - 1e-9);
    expect(sized!.best.amountIn).toBeLessThanOrEqual(40 + 1e-9);
    expect(sized!.tried.every((t) => t.amountIn >= 5 - 1e-9 && t.amountIn <= 40 + 1e-9)).toBe(true);
  });

  it("returns null when the ceiling is below the clip floor", () => {
    const snap = mkSnap([mkPool(50_000, 500_000_000)]);
    expect(
      optimizeEntrySize({
        snap, tokenIn: "WAX", tokenOut: "LEEF", expectedGrossPct: 8,
        minNetEdgePct: 0.1, minIn: 10, maxIn: 4, volPerSec: 0,
      }),
    ).toBeNull();
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
      expect(d.amountWax).toBeLessThanOrEqual(50);
      expect(d.edge).toBeDefined();
      expect(d.reason).toMatch(/EV \$|net /);
    }
  });

  it("staked WAX has no transfer fee — a micro clip can still pass", () => {
    const snap = mkSnap([mkPool(50_000, 500_000_000)]);
    const v = evaluateEntry({
      snap,
      tokenIn: "WAX",
      tokenOut: "LEEF",
      amountIn: 0.01 / WAX_USD,
      expectedGrossPct: 5,
      minNetEdgePct: 0,
      volPerSec: 0,
    });
    expect(v).not.toBeNull();
    expect(v!.costs.fixedUsd).toBe(0);
    expect(v!.pass).toBe(true);
  });

  it("volume maker: same-pool echo inside the LP-fee budget is a trade, not a hold", () => {
    const snap = mkSnap([mkPool(50_000, 500_000_000)]);
    const d = evaluateBot(
      botInput({
        snap,
        strategy: "volume",
        balances: { WAX: 50 },
        risk: { ...DEFAULT_RISK, maxEchoLossPct: 1.5, minTradeUsd: 0 },
      }),
    );
    expect(d.kind).toBe("arb");
    if (d.kind === "arb") {
      expect(d.arbKind).toBe("volume");
      expect(d.plan.waxIn).toBeGreaterThan(0);
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

  it("regression: evaluating an exit with an open position does not throw", () => {
    // bestSellRoute used to reference an out-of-scope identifier, crashing
    // every sell evaluation with ReferenceError.
    const snap = mkSnap([mkPool(50_000, 500_000_000)]);
    const d = evaluateBot(
      botInput({
        snap,
        strategy: "auto",
        position: {
          amountLeef: 1_000_000,
          entryUsd: snap.leefUsd,
          entryCostUsd: 10,
          entryWax: 500,
          since: Date.now() - 60_000,
          highUsd: snap.leefUsd,
          mode: "paper",
        },
        balances: { WAX: 50, "LEEF@leefmaincorp": 1_000_000 },
      }),
    );
    expect(["hold", "sell", "buy", "arb", "swap", "stop"]).toContain(d.kind);
  });

  it("caps a sell at the actual wallet base balance, never above it", () => {
    const snap = mkSnap([mkPool(50_000, 500_000_000)]);
    const d = evaluateBot(
      botInput({
        snap,
        force: "sell",
        position: {
          amountLeef: 1_000_000, // position tracking says 1M…
          entryUsd: snap.leefUsd,
          entryCostUsd: 10,
          entryWax: 500,
          since: Date.now() - 60_000,
          highUsd: snap.leefUsd,
          mode: "paper",
        },
        // …but the wallet provably holds only 400k.
        balances: { WAX: 50, "LEEF@leefmaincorp": 400_000 },
      }),
    );
    expect(d.kind).toBe("sell");
    if (d.kind === "sell") {
      expect(d.amountLeef).toBe(400_000);
      expect(d.reason).toMatch(/capped at wallet balance/);
    }
  });

  it("auto strategy: no deployable quote → clean hold, not a failed trade", () => {
    const snap = mkSnap([mkPool(50_000, 500_000_000)]);
    const d = evaluateBot(
      botInput({
        snap,
        strategy: "auto",
        balances: { WAX: 0 },
      }),
    );
    expect(d.kind).toBe("hold");
    expect(d.reason).toMatch(/Auto scan|no deployable|warming up/i);
  });

  it("auto strategy: picks the grid entry when it clears net edge", () => {
    const snap = mkSnap([mkPool(50_000, 500_000_000)]);
    const d = evaluateBot(
      botInput({
        snap,
        strategy: "auto",
        gridAnchor: anchorAbove(snap),
        // Disable the echo fallback so a failed entry can't masquerade as a buy.
        risk: { ...DEFAULT_RISK, maxEchoLossPct: 0 },
      }),
    );
    expect(d.kind).toBe("buy");
    if (d.kind === "buy") {
      expect(d.reason).toMatch(/Auto:/);
      expect(d.edge).toBeDefined();
    }
  });

  it("auto strategy: takes a profitable arb when one exists", () => {
    // Two WAX/LEEF pools with a wide price gap → atomic spread clears the gate.
    const cheap = { ...mkPool(50_000, 500_000_000), id: 1159 };
    const rich = { ...mkPool(52_000, 400_000_000), id: 217 };
    const snap = mkSnap([cheap, rich]);
    const d = evaluateBot(
      botInput({
        snap,
        strategy: "auto",
        // Pin the grid anchor at market so no grid thesis competes with the
        // arb, and disable the echo fallback so the outcome is deterministic.
        gridAnchor: snap.leefUsd,
        risk: { ...DEFAULT_RISK, minEdgePct: 0.5, minNetEdgePct: 0.1, maxEchoLossPct: 0 },
        balances: { WAX: 500 },
      }),
    );
    expect(d.kind).toBe("arb");
    if (d.kind === "arb") {
      expect(d.arbKind).toBe("spread");
      expect(d.reason).toMatch(/Auto: arb/);
    }
  });
});
