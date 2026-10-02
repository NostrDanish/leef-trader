/**
 * Safer-default circuit breakers (drawdown + session loss) and the
 * liquidity-relative position cap. Fixture copied from net-edge.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GOALS,
  DEFAULT_RISK,
  evaluateBot,
  sessionLossCapUsd,
  type BotInput,
} from "./bot-engine";
import { migrateSaferRiskDefaults } from "./risk-defaults-migration";
import { deepestPairTvlUsd, usdToTokenBounds } from "./risk-usd";
import type { AuxPool, LeefPool, LeefSnapshot } from "./types";

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

describe("safer defaults", () => {
  it("ships with drawdown + session-loss breakers on and tighter pacing", () => {
    expect(DEFAULT_GOALS.maxDrawdownPct).toBe(10);
    expect(DEFAULT_GOALS.maxDailyLossPct).toBe(3);
    expect(DEFAULT_GOALS.maxSessionLossUsd).toBe(0);
    expect(DEFAULT_RISK.maxTradesHour).toBe(20);
    expect(DEFAULT_RISK.cooldownSec).toBe(30);
    expect(DEFAULT_RISK.maxPoolSharePct).toBe(5);
  });
});

describe("session loss breaker", () => {
  it("derives the cap from maxDailyLossPct when no USD cap is set", () => {
    expect(sessionLossCapUsd({ maxSessionLossUsd: 0, maxDailyLossPct: 3 }, 100)).toBeCloseTo(3, 9);
    expect(sessionLossCapUsd({ maxSessionLossUsd: 7, maxDailyLossPct: 3 }, 100)).toBe(7);
    expect(sessionLossCapUsd({ maxSessionLossUsd: 0, maxDailyLossPct: 0 }, 100)).toBe(0);
    expect(sessionLossCapUsd({ maxSessionLossUsd: 0, maxDailyLossPct: 3 }, 0)).toBe(0);
  });

  // 5000 WAX × $0.02 = $100 marked equity — no drawdown, only realized loss.
  it("the defaults alone stop the bot at −3.01 realized on a $100 start", () => {
    const d = evaluateBot(botInput({ balances: { WAX: 5000 }, sessionStartEquityUsd: 100, sessionRealizedUsd: -3.01 }));
    expect(d.kind).toBe("stop");
    expect(d.reason).toMatch(/Session loss limit/);
  });

  it("does not stop at −2.99", () => {
    const d = evaluateBot(botInput({ balances: { WAX: 5000 }, sessionStartEquityUsd: 100, sessionRealizedUsd: -2.99 }));
    expect(d.kind).not.toBe("stop");
  });

  it("an explicit USD cap wins over the percent", () => {
    const d = evaluateBot(
      botInput({
        goals: { ...DEFAULT_GOALS, maxSessionLossUsd: 1 },
        balances: { WAX: 5000 },
        sessionStartEquityUsd: 100,
        sessionRealizedUsd: -1.5,
      }),
    );
    expect(d.kind).toBe("stop");
  });

  it("0 / 0 disables it (explicit opt-out)", () => {
    const d = evaluateBot(
      botInput({
        goals: { ...DEFAULT_GOALS, maxSessionLossUsd: 0, maxDailyLossPct: 0, maxDrawdownPct: 0 },
        sessionStartEquityUsd: 100,
        sessionRealizedUsd: -50,
      }),
    );
    expect(d.kind).not.toBe("stop");
  });
});

describe("drawdown breaker (default 10%)", () => {
  it("stops when marked equity is more than 10% under the session start", () => {
    // balances: 50 WAX × $0.02 = $1.00 marked; start $1.12 → −10.7%.
    const d = evaluateBot(botInput({ sessionStartEquityUsd: 1.12 }));
    expect(d.kind).toBe("stop");
    expect(d.reason).toMatch(/drawdown/i);
  });

  it("does not stop inside the band", () => {
    const d = evaluateBot(botInput({ sessionStartEquityUsd: 1.05 }));
    expect(d.kind).not.toBe("stop");
  });
});

function auxPool(id: number, a: string, b: string, tvlUsd: number): AuxPool {
  return {
    id,
    fee: 3000,
    tokenA: { symbol: a, contract: "x", decimals: 4, quantity: 1 },
    tokenB: { symbol: b, contract: "y", decimals: 4, quantity: 1 },
    tvlUsd,
  } as unknown as AuxPool;
}

describe("liquidity-relative position cap", () => {
  it("deepestPairTvlUsd picks the deepest direct pool, null without one", () => {
    const snap = { ...mkSnap([mkPool(50_000, 500_000_000)]), aux: [auxPool(9, "WAX", "LEEF", 9_999_999)] };
    expect(deepestPairTvlUsd(snap, "LEEF", "WAX")).toBe(9_999_999);
    expect(deepestPairTvlUsd(snap, "LEEF", "TLM")).toBeNull();
  });

  it("$1,631 TVL × 5% → $81.55 cap binds under maxPositionUsd 100", () => {
    const pool = { ...mkPool(50_000, 500_000_000), tvlUsd: 1631 };
    const b = usdToTokenBounds({
      snap: mkSnap([pool]),
      quote: "WAX",
      base: "LEEF",
      risk: { minTradeUsd: 0, maxPositionUsd: 100, operationalReserveUsd: 0, maxPoolSharePct: 5 },
      position: null,
      balances: { WAX: 1_000_000 },
    });
    if ("error" in b) throw new Error(b.error);
    expect(b.liquidityCapUsd).toBeCloseTo(81.55, 6);
    expect(b.effectiveMaxUsd).toBeCloseTo(81.55, 6);
  });

  it("a direct pool with zero TVL fails closed (cap 0)", () => {
    const pool = { ...mkPool(50_000, 500_000_000), tvlUsd: 0 };
    const b = usdToTokenBounds({
      snap: mkSnap([pool]),
      quote: "WAX",
      base: "LEEF",
      risk: { minTradeUsd: 0, maxPositionUsd: 100, operationalReserveUsd: 0, maxPoolSharePct: 5 },
      position: null,
      balances: { WAX: 1_000_000 },
    });
    if ("error" in b) throw new Error(b.error);
    expect(b.effectiveMaxUsd).toBe(0);
  });

  it("no cap when maxPoolSharePct is unset or 0 (backwards compatible)", () => {
    const pool = { ...mkPool(50_000, 500_000_000), tvlUsd: 1631 };
    const b = usdToTokenBounds({
      snap: mkSnap([pool]),
      quote: "WAX",
      base: "LEEF",
      risk: { minTradeUsd: 0, maxPositionUsd: 100, operationalReserveUsd: 0 },
      position: null,
      balances: { WAX: 1_000_000 },
    });
    if ("error" in b) throw new Error(b.error);
    expect(b.liquidityCapUsd).toBeUndefined();
    expect(b.effectiveMaxUsd).toBe(100);
  });
});

describe("persisted-state migration (bot store v13)", () => {
  it("maps legacy defaults to the safer ones and explains it", () => {
    const m = migrateSaferRiskDefaults(
      { maxDrawdownPct: 0, takeProfitPct: 6 },
      { maxTradesHour: 120, cooldownSec: 15 },
    );
    expect(m.goals).toMatchObject({ maxDrawdownPct: 10, maxDailyLossPct: 3, maxSessionLossUsd: 0 });
    expect(m.risk).toMatchObject({ maxTradesHour: 20, cooldownSec: 30, maxPoolSharePct: 5 });
    expect(m.notice).toMatch(/Safer risk defaults/);
  });

  it("keeps values the user customized", () => {
    const m = migrateSaferRiskDefaults(
      { maxDrawdownPct: 25, maxDailyLossPct: 0, maxSessionLossUsd: 0 },
      { maxTradesHour: 60, cooldownSec: 45, maxPoolSharePct: 2 },
    );
    expect(m.goals).toEqual({});
    expect(m.risk).toEqual({});
    expect(m.notice).toBeNull();
  });
});
