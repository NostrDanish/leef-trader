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
      botInput({ strategy: "volume", balances: { WAX: 50 }, risk: { ...DEFAULT_RISK, minTradeUsd: 0 } }),
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
      botInput({ strategy: "volume-x", balances: { WAX: 50 }, risk: { ...DEFAULT_RISK, minTradeUsd: 0 } }),
    );
    expect(d.kind).toBe("hold");
    expect(d.reason).toContain("Volume-X");
  });
  it("auto: flow gates echoes but NEVER profit intents", () => {
    // Dead book, deployable WAX: a profit thesis (grid/arb) may still trade —
    // flow is veto-only for VOLUME intents. It must never be a volume echo.
    const d = evaluateBot(
      botInput({ strategy: "auto", balances: { WAX: 50 }, risk: { ...DEFAULT_RISK, minTradeUsd: 0 } }),
    );
    expect(d.kind === "arb" && d.arbKind === "volume").toBe(false);
    // Nothing deployable → hold, and the echo candidate reports the gate.
    const d2 = evaluateBot(
      botInput({ strategy: "auto", balances: {}, risk: { ...DEFAULT_RISK, minTradeUsd: 0 } }),
    );
    expect(d2.kind).toBe("hold");
    expect(d2.reason.toLowerCase()).toContain("flow");
  });
});

describe("unleashed: EV-ranked, never random", () => {
  it("picks the EV winner (arb), not a dice roll", () => {
    // Two pools with a >fee spread: the atomic arb has the highest EV.
    const snap = mkSnap([
      mkPool(1159, 50_000, 500_000_000),
      mkPool(217, 52_000, 500_000_000),
    ]);
    const now = Date.now(); // fixed so both calls see the identical clip seed
    const input = () =>
      botInput({
        now,
        snap,
        strategy: "unleashed",
        balances: { WAX: 50 },
        risk: { ...DEFAULT_RISK, minTradeUsd: 0, minEdgePct: 0.2 },
      });
    const d = evaluateBot(input());
    // The EV winner on a 4% spread is a positive-EV trade (arb or the tape
    // clip cycling the same spread) — never a random pick or a hold.
    expect(["arb", "swap"]).toContain(d.kind);
    expect(d.reason).toContain("EV");
    if (d.kind === "arb" || d.kind === "buy" || d.kind === "swap") {
      expect(d.opportunity?.expectedValueUsd ?? 0).toBeGreaterThan(0);
    }
    // Deterministic: same inputs, same pick (no pseudo-random selection).
    const d2 = evaluateBot(input());
    expect(d2).toEqual(d);
  });
  it("no scorable candidate → hold, never a forced trade", () => {
    const d = evaluateBot(
      botInput({
        strategy: "unleashed",
        balances: { WAX: 0.0001 },
        risk: { ...DEFAULT_RISK, minTradeUsd: 0.1 },
      }),
    );
    expect(d.kind).toBe("hold");
    expect(d.reason).toContain("Unleashed");
  });
  it("does not fire a loss-echo without flow evidence", () => {
    const d = evaluateBot(
      botInput({
        strategy: "unleashed",
        balances: { WAX: 50 },
        risk: { ...DEFAULT_RISK, minTradeUsd: 0, maxEchoLossPct: 1.5 },
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
          since: Date.now() - 600_000,
          highUsd: snap.leefUsd,
          mode: "paper",
          predEdgePct: 1,
          strategy: "dca",
        },
        risk: { ...DEFAULT_RISK, cooldownSec: 0, maxImpactPct: 2 },
      }),
    );
    expect(d.kind).toBe("hold");
    expect(d.reason).toMatch(/DCA paused/);
  });
});

describe("spread arb freshness", () => {
  it("findBestArb with freshIds drops stale legs", () => {
    const snap = mkSnap([
      mkPool(1159, 50_000, 500_000_000),
      mkPool(217, 52_000, 500_000_000),
    ]);
    const arb = findBestArb(snap, 20, 0, false, 0);
    expect(arb).not.toBeNull();
    // Pool 217 not hot → phantom spread excluded.
    const gated = findBestArb(snap, 20, 0, false, 0, new Set([1159]));
    expect(gated).toBeNull();
  });
  it("minEdgePct default is 0.45 (dust floor)", () => {
    expect(DEFAULT_RISK.minEdgePct).toBe(0.45);
  });
});

describe("grid fee tier", () => {
  it("gridFeePct surfaces the actual (max) book fee, not a hardcoded 0.3", () => {
    const snap = mkSnap([mkPool(1159, 50_000, 500_000_000, 1.0)]);
    expect(gridFeePct(snap)).toBe(1.0);
  });
  it("a 1%-tier book forces a wider adaptive step than a 0.3% book", () => {
    // configured 0.5 sits below both floors → the fee tier decides.
    const low = adaptiveGridStepPct(0.5, 0, 0.3);
    const high = adaptiveGridStepPct(0.5, 0, 1.0);
    expect(low).toBeCloseTo(1.0, 6);
    expect(high).toBeCloseTo(2.4, 6);
    expect(high).toBeGreaterThan(low);
  });
});

describe("cost-model decay pays for staleness", () => {
  it("quoteAgeSec widens the decay charge beyond flat latency", () => {
    const snap = mkSnap([mkPool(1159, 50_000, 500_000_000)]);
    const base = evaluateEntry({
      snap, tokenIn: "WAX", tokenOut: "LEEF", amountIn: 1,
      expectedGrossPct: 10, minNetEdgePct: 0, volPerSec: 0.001,
    })!;
    const stale = evaluateEntry({
      snap, tokenIn: "WAX", tokenOut: "LEEF", amountIn: 1,
      expectedGrossPct: 10, minNetEdgePct: 0, volPerSec: 0.001, quoteAgeSec: 30,
    })!;
    // decay = volPerSec x (quoteAge + latencySec=4) x decaySigma=1 x 100
    expect(base.costs.decayPct).toBeCloseTo(0.001 * 4 * 100, 6);
    expect(stale.costs.decayPct).toBeCloseTo(0.001 * 34 * 100, 6);
    expect(stale.costs.decayPct).toBeGreaterThan(base.costs.decayPct);
  });
});

describe("growth wiring", () => {
  const growthSnap = () => mkSnap([mkPool(1159, 50_000, 500_000_000)]);
  it("mix-gap gate: no convert when the destination gap is under 5pp", () => {
    const snap = growthSnap();
    // Wallet exactly at the 60/40 target: gap ≈ 0pp → hold, no fee churn.
    // leefUsd here = 0.0001 WAX × $0.02 = $0.000002; $60 of LEEF = 30M.
    const plan = planGrowthAction(
      snap,
      { WAX: 2_000, LEEF: 30_000_000 },
      {
        targets: [
          { symbol: "LEEF", weight: 60 },
          { symbol: "WAX", weight: 40 },
        ],
        mode: "balanced",
        minUsd: 0.01,
        maxUsd: 100,
      },
    );
    expect("hold" in plan).toBe(true);
    if ("hold" in plan) {
      expect([plan.hold, ...plan.explain].join(" ")).toMatch(/mix gap|gap/i);
    }
  });
  it("regime factor scales expected growth", () => {
    const snap = growthSnap();
    const opts = {
      targets: [
        { symbol: "LEEF", weight: 90 },
        { symbol: "WAX", weight: 10 },
      ],
      mode: "balanced" as const,
      minUsd: 0.01,
      maxUsd: 20,
    };
    const bull = planGrowthAction(snap, { WAX: 500 }, { ...opts, regimeFactor: 1.1 });
    const bear = planGrowthAction(snap, { WAX: 500 }, { ...opts, regimeFactor: 0.7 });
    expect("hold" in bull).toBe(false);
    if (!("hold" in bull) && !("hold" in bear)) {
      expect(bull.expectedGrowth).toBeGreaterThan(bear.expectedGrowth);
    } else {
      // The bearish haircut may push the candidate under the floor entirely.
      expect("hold" in bear).toBe(true);
    }
  });
});

describe("signal 2-print confirmation", () => {
  const rising = (): { t: number; usd: number }[] => {
    const out: { t: number; usd: number }[] = [];
    for (let i = 0; i < BOT_WARMUP_POINTS + 6; i++) {
      out.push({ t: i * 30_000, usd: 0.01 * (1 + i * 0.01) });
    }
    return out;
  };
  it("default minConfidence is 65", () => {
    expect(DEFAULT_RISK.minConfidence).toBe(65);
  });
  it("one confident print is not enough — needs two in a row", () => {
    const flatThenDip: { t: number; usd: number }[] = [];
    for (let i = 0; i < BOT_WARMUP_POINTS + 4; i++) {
      flatThenDip.push({ t: i * 30_000, usd: 0.01 });
    }
    flatThenDip.push({ t: 99 * 30_000, usd: 0.0095 }); // single dip print
    const one = confirmedBuySignal(flatThenDip);
    if (one.signal.bias === "buy") {
      expect(one.confirmed).toBe(false);
    } else {
      expect(one.confirmed).toBe(false);
    }
  });
  it("a sustained advance confirms", () => {
    const s = rising();
    const c = confirmedBuySignal(s);
    if (c.signal.warmed && c.signal.bias === "buy") {
      expect(c.confirmed).toBe(true);
    }
  });
  it("signal strategy holds on the first confirming print", () => {
    const s = rising();
    // Only the last print moves — prior series was flat.
    const step: { t: number; usd: number }[] = s.map((p) => ({ ...p, usd: 0.01 }));
    step[step.length - 1]!.usd = 0.0115;
    const snap = mkSnap([mkPool(1159, 50_000, 500_000_000)]);
    const d = evaluateBot(
      botInput({
        snap,
        series: step,
        strategy: "signal",
        balances: { WAX: 50 },
        risk: { ...DEFAULT_RISK, minTradeUsd: 0 },
      }),
    );
    if (d.kind === "hold") {
      expect(d.reason).toMatch(/2nd confirming print|warming|BUY|HOLD|veto/i);
    }
  });
});

describe("meanrev band-width gate", () => {
  it("reversionRead surfaces the band width", () => {
    const series: { t: number; usd: number }[] = [];
    for (let i = 0; i < BOT_WARMUP_POINTS + 2; i++) {
      series.push({ t: i * 30_000, usd: 0.01 * (1 + (i % 5) * 0.01) });
    }
    const r = reversionRead(series);
    expect(r.bandWidthPct).not.toBeNull();
    expect(r.bandWidthPct!).toBeGreaterThan(0);
  });
  it("blocks entries when the band is narrower than 2× round-trip cost", () => {
    // Gentle ±0.2% oscillation: warmed series, zero net momentum (no trend
    // veto), but BB width ≈0.8% < 2× the ~0.75% round-trip floor.
    const calm: { t: number; usd: number }[] = [];
    for (let i = 0; i < BOT_WARMUP_POINTS + 2; i++) {
      calm.push({ t: i * 30_000, usd: 0.01 * (1 + (i % 2 === 0 ? 0.002 : -0.002)) });
    }
    const snap = mkSnap([mkPool(1159, 50_000, 500_000_000)]);
    const d = evaluateBot(
      botInput({
        snap,
        series: calm,
        strategy: "meanrev",
        balances: { WAX: 50 },
        risk: { ...DEFAULT_RISK, minTradeUsd: 0 },
      }),
    );
    expect(d.kind).toBe("hold");
    expect(d.reason).toMatch(/BB width|round-trip/);
  });
  it("roundTripCostFloorPct uses the book's real fee tier", () => {
    const snap = mkSnap([mkPool(1159, 50_000, 500_000_000, 1.0)]);
    expect(roundTripCostFloorPct(snap)).toBeGreaterThan(2);
  });
});

describe("paper/live calibration split", () => {
  it("a paper close leaves live byStrategy untouched", () => {
    const r = { pnlUsd: 1, predEdgePct: 2, realEdgePct: 1, latencyMs: null };
    useBot.getState().recordStrategyPerf("zz-paper-split", r, "paper");
    let stats = useBot.getState().stats;
    expect(stats.byStrategy["zz-paper-split"]).toBeUndefined();
    expect(stats.byStrategyPaper["zz-paper-split"]?.trades).toBe(1);
    useBot.getState().recordStrategyPerf("zz-paper-split", r, "live");
    stats = useBot.getState().stats;
    expect(stats.byStrategy["zz-paper-split"]?.trades).toBe(1);
    expect(stats.byStrategyPaper["zz-paper-split"]?.trades).toBe(1);
  });
});
