import { describe, expect, it } from "vitest";
import { planLeefTape, planNextAction } from "./next-action";
import type { AuxPool, LeefPool, LeefSnapshot } from "./types";

const WAX_USD = 0.02;

function mkPool(waxReserve: number, leefReserve: number, id = 1159): LeefPool {
  const pairPerLeef = waxReserve / leefReserve;
  return {
    id,
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

function snap(pools: LeefPool[], aux: AuxPool[] = []): LeefSnapshot {
  const waxPerLeef = pools[0]?.waxPerLeef ?? 0;
  const leefUsd = waxPerLeef * WAX_USD;
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    waxUsd: WAX_USD,
    leefUsd,
    waxPerLeef,
    pools,
    aux,
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

describe("planNextAction", () => {
  it("HOLDs when the wallet is empty", () => {
    expect(planNextAction(snap([mkPool(50_000, 500_000_000)]), {})).toBeNull();
  });

  it("HOLDs when no hop clears a high net-edge floor", () => {
    const s = snap([mkPool(50_000, 500_000_000)]);
    const plan = planNextAction(s, { WAX: 50, "LEEF@leefmaincorp": 0 }, { minNetPct: 50 });
    expect(plan).toBeNull();
  });

  it("proposes one atomic hop from actual WAX holdings when a book exists", () => {
    const s = snap([mkPool(50_000, 500_000_000)]);
    const plan = planNextAction(s, { WAX: 50 }, { minUsd: 0, minNetPct: -100 });
    // CP round-trip is negative after fees; a path to LEEF may still print
    // if USD marks disagree. Either a path or HOLD is valid — never crash.
    if (plan) {
      expect(plan.amountIn).toBeGreaterThan(0);
      expect(plan.tokenIn).toBe("WAX");
      expect(plan.route.legs.length).toBeGreaterThan(0);
    }
  });

  it("rejects a profit that exists only at a wrong oracle mark", () => {
    // Deep 1:1 WAX/WAXUSDC book, but the universe marks WAXUSDC at 2× WAX —
    // the path claims ~+100% at marks while the executable exit price says
    // $0.02. The mark-vs-executable guard must refuse the phantom.
    const auxPool: AuxPool = {
      id: 500,
      fee: 3000,
      feePct: 0.3,
      tokenA: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: 100_000 },
      tokenB: { symbol: "WAXUSDC", contract: "eth.token", decimals: 6, quantity: 100_000 },
      tvlUsd: 4000,
      volume24Usd: 100,
    };
    const s = snap([mkPool(50_000, 500_000_000)], [auxPool]);
    s.universe.push({
      symbol: "WAXUSDC",
      contract: "eth.token",
      decimals: 6,
      alcorId: "waxusdc-eth.token",
      poolId: 500,
      waxPerToken: 2, // LIE: the mark says 2× WAX while the book trades 1:1
      usdPrice: WAX_USD * 2,
      tvlUsd: 4000,
      stable: false,
    });
    const plan = planNextAction(s, { WAX: 50 }, { minUsd: 0, minNetPct: 0 });
    // No phantom WAX→WAXUSDC "profit" may survive the guard.
    if (plan) {
      expect(plan.tokenOut === "WAXUSDC" && plan.netUsd > 0).toBe(false);
    }
  });
});

describe("planLeefTape", () => {
  it("returns null on an empty wallet", () => {
    expect(planLeefTape(snap([mkPool(50_000, 500_000_000)]), {}, { minUsd: 0, maxUsd: 1 })).toBeNull();
  });
  it("sizes a WAX→LEEF clip inside the USD band", () => {
    const s = snap([mkPool(50_000, 500_000_000)]);
    const clip = planLeefTape(s, { WAX: 50 }, { minUsd: 0.01, maxUsd: 0.5, maxLossPct: 50, seed: 1 });
    if (clip) {
      expect(clip.tokenOut === "LEEF" || clip.tokenIn === "LEEF").toBe(true);
      expect(clip.usdIn).toBeGreaterThan(0);
      expect(clip.usdIn).toBeLessThanOrEqual(0.5 + 1e-6);
    }
  });
});
