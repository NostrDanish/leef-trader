/**
 * Strategy-fitness upgrade tests: flow gate, unleashed EV ranking, F0
 * freshness, DCA cadence/preflight, arb freshness, grid fee tier, cost
 * decay, growth wiring, signal confirmation, meanrev band gate.
 */
import { describe, expect, it } from "vitest";
import {
  adaptiveCooldownSec,
  adaptiveGridStepPct,
  BOT_WARMUP_POINTS,
  confirmedBuySignal,
  DEFAULT_GOALS,
  DEFAULT_RISK,
  evaluateBot,
  findBestArb,
  gridFeePct,
  reversionRead,
  roundTripCostFloorPct,
  volumeGateReason,
  type BotInput,
} from "./bot-engine";
import { evaluateEntry } from "./net-edge";
import { planGrowthAction } from "./growth-engine";
import { snapFreshAtMs, type LeefPool, type LeefSnapshot } from "./types";
import { useBot } from "@/store/bot";
import type { PoolFlowState } from "@/lib/market/swap-flow";

const WAX_USD = 0.02;

function mkPool(id: number, waxReserve: number, leefReserve: number, feePct = 0.3): LeefPool {
  const pairPerLeef = waxReserve / leefReserve;
  return {
    id,
    fee: feePct * 10_000,
    feePct,
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

function mkSnap(pools: LeefPool[], spotAt?: string): LeefSnapshot {
  const waxPerLeef = pools[0]?.waxPerLeef ?? 0;
  const leefUsd = waxPerLeef * WAX_USD;
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    ...(spotAt ? { spotAt } : {}),
    waxUsd: WAX_USD,
    leefUsd,
    waxPerLeef,
    pools,
    aux: [],
    trades: [],
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
    snap: mkSnap([mkPool(1159, 50_000, 500_000_000)]),
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

function liveFlow(poolId: number, ageMs = 60_000): PoolFlowState {
  return {
    poolId,
    swapsInWindow: 2,
    buys: 1,
    sells: 1,
    signedBaseFlow: 0,
    signedQuoteFlow: 0,
    imbalancePct: 0,
    volumeQuotePerMin: 1,
    largestSwapQuote: 5,
    lastSwapAt: Date.now() - ageMs,
    lastSwapAgeMs: ageMs,
    lastMovePct: 0,
  };
}

describe("volume flow gate", () => {
  it("fails closed when flow data is unavailable", () => {
    const d = evaluateBot(
      botInput({
        strategy: "volume",
        balances: { WAX: 50 },
        risk: { ...DEFAULT_RISK, minTradeUsd: 0, volumeFlowGateMin: 10 },
      }),
    );
    expect(d.kind).toBe("hold");
    expect(d.reason.toLowerCase()).toContain("flow");
  });
  it("holds when the last third-party swap is older than the gate", () => {
    const why = volumeGateReason(
      { flowStates: [liveFlow(1159, 30 * 60_000)] },
      { volumeFlowGateMin: 10, echoBudgetUsd: 5 },
      [1159],
    );
    expect(why).toMatch(/last third-party swap/);
  });
  it("passes with fresh third-party flow inside the window", () => {
    const why = volumeGateReason(
      { flowStates: [liveFlow(1159, 60_000)] },
      { volumeFlowGateMin: 10, echoBudgetUsd: 5 },
      [1159],
    );
    expect(why).toBeNull();
  });
  it("session echo budget stops volume intents once spent", () => {
    const why = volumeGateReason(
      { flowStates: [liveFlow(1159)], echoCostUsd: 5.01 },
      { volumeFlowGateMin: 10, echoBudgetUsd: 5 },
      [1159],
    );
    expect(why).toMatch(/echo budget/);
  });
  it("volumeFlowGateMin = 0 disables the flow gate entirely (off-switch)", () => {
    // No flow data at all → normally fails closed; with 0 the gate is off.
    expect(
      volumeGateReason({ flowStates: null }, { volumeFlowGateMin: 0, echoBudgetUsd: 5 }, [1159]),
    ).toBeNull();
    expect(
      volumeGateReason(
        { flowStates: undefined },
        { volumeFlowGateMin: 0, echoBudgetUsd: 5 },
        [1159],
      ),
    ).toBeNull();
    // Stale flow that would fail the 10-min gate passes when the gate is off.
    expect(
      volumeGateReason(
        { flowStates: [liveFlow(1159, 30 * 60_000)] },
        { volumeFlowGateMin: 0, echoBudgetUsd: 5 },
        [1159],
      ),
    ).toBeNull();
    // The echo budget is a separate control — it still applies with the gate off.
    expect(
      volumeGateReason(
        { flowStates: null, echoCostUsd: 5.01 },
        { volumeFlowGateMin: 0, echoBudgetUsd: 5 },
        [1159],
      ),
    ).toMatch(/echo budget/);
  });
  it("evaluateBot: gate off at 0 lets the volume strategy past the flow check", () => {
    const d = evaluateBot(
      botInput({
        strategy: "volume",
        balances: { WAX: 50 },
        risk: { ...DEFAULT_RISK, minTradeUsd: 0, volumeFlowGateMin: 0 },
      }),
    );
    // Whatever it decides, it must NOT be the flow gate holding it back.
    if (d.kind === "hold") expect(d.reason.toLowerCase()).not.toContain("flow");
  });
  it("volume-x fails closed without flow data", () => {
    const d = evaluateBot(
      botInput({
        strategy: "volume-x",
        balances: { WAX: 50 },
        risk: { ...DEFAULT_RISK, minTradeUsd: 0, volumeFlowGateMin: 10 },
        flowStates: undefined,
      }),
    );
    expect(d.kind).toBe("hold");
    expect(d.reason).toContain("Volume-X");
  });
  it("auto: flow gates echoes but NEVER profit intents", () => {
    // Dead book, deployable WAX: a profit thesis (grid/arb) may still trade —
    // flow is veto-only for VOLUME intents. It must never be a volume echo.
    const d = evaluateBot(
      botInput({
        strategy: "auto",
        balances: { WAX: 50 },
        risk: { ...DEFAULT_RISK, minTradeUsd: 0, volumeFlowGateMin: 10 },
      }),
    );
    expect(d.kind === "arb" && d.arbKind === "volume").toBe(false);
    // Nothing deployable → hold, and the echo candidate reports the gate.
    const d2 = evaluateBot(
      botInput({
        strategy: "auto",
        balances: {},
        risk: { ...DEFAULT_RISK, minTradeUsd: 0, volumeFlowGateMin: 10 },
        flowStates: undefined,
      }),
    );
    expect(d2.kind).toBe("hold");
    expect(d2.reason.toLowerCase()).toContain("flow");
  });
});

describe("unleashed: EV-ranked, never random", () => {
  it("picks the EV winner (arb), not a dice roll", () => {
    const snap = mkSnap([
      mkPool(1159, 50_000, 500_000_000),
      mkPool(217, 50_100, 500_000_000),
    ]);
    const d = evaluateBot(
      botInput({ snap, strategy: "unleashed", balances: { WAX: 50 } }),
    );
    expect(d.kind).toBe("arb");
    if (d.kind === "arb") {
      expect(d.arbKind).toBe("spread");
      expect(d.plan.buyPool.id).toBe(1159);
      expect(d.plan.sellPool.id).toBe(217);
    }
  });

  it("does not fire a loss-echo without flow evidence", () => {
    const d = evaluateBot(
      botInput({
        strategy: "unleashed",
        balances: { WAX: 50 },
        risk: {
          ...DEFAULT_RISK,
          minTradeUsd: 0,
          maxEchoLossPct: 1.5,
          volumeFlowGateMin: 10,
        },
        flowStates: undefined,
      }),
    );
    expect(d.kind).toBe("hold");
    expect(d.reason.toLowerCase()).toContain("flow");
  });
});

describe("F0 freshness: max(fetchedAt, spotAt)", () => {
  it("snapFreshAtMs prefers a newer on-chain spot patch", () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    const fresh = new Date(Date.now() - 2_000).toISOString();
    const snap = mkSnap([mkPool(1159, 50_000, 500_000_000)], fresh);
    snap.fetchedAt = old;
    expect(Date.now() - snapFreshAtMs(snap)).toBeLessThan(10_000);
  });
  it("a chain-patched book does not score stale in the engine", () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    const fresh = new Date(Date.now() - 1_000).toISOString();
    const snap = mkSnap([mkPool(1159, 50_000, 500_000_000)], fresh);
    snap.fetchedAt = old;
    const d = evaluateBot(botInput({ snap, strategy: "grid", balances: { WAX: 50 } }));
    expect(d.reason.toLowerCase()).not.toContain("stale");
  });
});

describe("DCA cadence + exit preflight", () => {
  it("dca cooldown factor is 20× (≈5 min at default), not 2×", () => {
    expect(adaptiveCooldownSec(15, "dca", 0)).toBe(300);
    expect(adaptiveCooldownSec(15, "auto", 0)).toBe(15);
  });
  it("refuses a new clip when the accumulated bag's exit impact exceeds the cap", () => {
    // 20k WAX / 20M LEEF pool: a 500k LEEF bag exits at ≈2.4% impact > 2% cap.
    const snap = mkSnap([mkPool(1159, 20_000, 20_000_000)]);
    const d = evaluateBot(
      botInput({
        snap,
        strategy: "dca",
        balances: { WAX: 50, LEEF: 500_000 },
        position: {
          amountLeef: 500_000,
          entryUsd: snap.leefUsd,
          entryCostUsd: 500_000 * snap.leefUsd,
          entryWax: 500,
          since: Date.now(),
          highUsd: snap.leefUsd,
          mode: "paper",
        },
        risk: { ...DEFAULT_RISK, maxImpactPct: 2 },
      }),
    );
    expect(d.kind).toBe("hold");
    expect(d.reason.toLowerCase()).toContain("stranded");
  });
});

describe("arb freshness hygiene", () => {
  it("skips a cross-pool arb when one leg is a stale book", () => {
    const snap = mkSnap([
      mkPool(1159, 50_000, 500_000_000),
      mkPool(217, 50_100, 500_000_000),
    ]);
    const fresh = findBestArb(snap, 10, 0.1);
    expect(fresh).not.toBeNull();
    // Only pool 1159 is "hot" — the phantom spread on 217 must not appear.
    const gated = findBestArb(snap, 10, 0.1, false, 0, new Set([1159]));
    expect(gated).toBeNull();
  });
});

describe("grid fee tier", () => {
  it("reads the actual book fee, not a hardcoded 0.3", () => {
    const snap = mkSnap([mkPool(1159, 50_000, 500_000_000, 1.0)]);
    expect(gridFeePct(snap, "WAX")).toBeCloseTo(1.0, 6);
    const step = adaptiveGridStepPct(2.5, 0, 1.0);
    expect(step).toBeGreaterThanOrEqual(2.4); // 2×1.0 + 0.4
  });
});

describe("cost decay", () => {
  it("penalizes slow quotes more on volatile books", () => {
    const snap = mkSnap([mkPool(1159, 50_000, 500_000_000)]);
    const calm = evaluateEntry({
      snap,
      tokenIn: "WAX",
      tokenOut: "LEEF",
      amountIn: 10,
      expectedGrossPct: 1,
      minNetEdgePct: 0,
      volPerSec: 0.00001,
      quoteAgeSec: 5,
    });
    const volatile = evaluateEntry({
      snap,
      tokenIn: "WAX",
      tokenOut: "LEEF",
      amountIn: 10,
      expectedGrossPct: 1,
      minNetEdgePct: 0,
      volPerSec: 0.01,
      quoteAgeSec: 45,
    });
    expect(volatile.totalPct).toBeGreaterThan(calm.totalPct);
  });
});

describe("growth engine wiring", () => {
  it("normalizeTargets caps at 3 entries and reweights to 100", () => {
    const out = normalizeTargets([
      { symbol: "LEEF", weight: 50 },
      { symbol: "WAX", weight: 30 },
      { symbol: "TLM", weight: 10 },
      { symbol: "TACO", weight: 10 },
    ]);
    expect(out).toHaveLength(3);
    expect(out.reduce((s, t) => s + t.weight, 0)).toBeCloseTo(100, 6);
  });
  it("planGrowthAction returns a hold on an empty book", () => {
    const snap = mkSnap([mkPool(1159, 0, 0)]);
    const plan = planGrowthAction(snap, { WAX: 0 }, [{ symbol: "LEEF", weight: 100 }], "balanced", {
      minUsd: 0,
      maxUsd: 100,
    });
    expect("hold" in plan).toBe(true);
  });
});

describe("signal confirmation", () => {
  it("confirmedBuySignal requires the previous print to also be a buy", () => {
    const series = Array.from({ length: BOT_WARMUP_POINTS + 2 }, (_, i) => ({
      t: Date.now() - (BOT_WARMUP_POINTS + 2 - i) * 30_000,
      usd: 0.01 + (i > BOT_WARMUP_POINTS ? 0.0001 : 0),
    }));
    const { confirmed } = confirmedBuySignal(series);
    // The last print moved up but the previous one did not vote buy.
    expect(confirmed).toBe(false);
  });
});

describe("meanrev band gate", () => {
  it("reversionRead reports nulls before warmup", () => {
    const { rsi, pctB } = reversionRead([]);
    expect(rsi).toBeNull();
    expect(pctB).toBeNull();
  });
  it("roundTripCostFloorPct uses the actual pool fee", () => {
    const snap = mkSnap([mkPool(1159, 50_000, 500_000_000, 1.0)]);
    const floor = roundTripCostFloorPct(snap, "WAX");
    expect(floor).toBeGreaterThan(2); // 2×1.0% + slippage + platform
  });
});

describe("adaptiveCooldownSec", () => {
  it("losing trades slow the bot down (anti-tilt)", () => {
    expect(adaptiveCooldownSec(15, "auto", -0.5)).toBeGreaterThan(adaptiveCooldownSec(15, "auto", 0));
  });
  it("never goes below the 10s floor", () => {
    expect(adaptiveCooldownSec(5, "auto", 0)).toBe(10);
  });
});
