import { describe, expect, it } from "vitest";
import { listBaseTokens, listQuoteTokens, suggestBotSettings, suggestPair } from "./advisor";
import { DEFAULT_RISK } from "./bot-engine";
import type { LeefPool, LeefSnapshot } from "./types";

function snap(): LeefSnapshot {
  const pool: LeefPool = {
    id: 1,
    fee: 3000,
    feePct: 0.3,
    leef: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: 50_000_000 },
    pair: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: 5_000 },
    leefIsA: true,
    tvlUsd: 200,
    volume24Usd: 10,
    volumeWeekUsd: 0,
    volumeUsdMonth: 0,
    volumeUsd90: 0,
    volumeLeef24: 0,
    volumePair24: 0,
    change24: 0,
    changeWeek: 0,
    liquidity: "0",
    pairPerLeef: 0.0001,
    leefPerPair: 10_000,
    waxPerLeef: 0.0001,
    usdPerLeef: 0.000002,
    tickSpacing: 60,
  };
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    waxUsd: 0.02,
    leefUsd: 0.000002,
    waxPerLeef: 0.0001,
    pools: [pool],
    aux: [],
    trades: [],
    universe: [
      {
        symbol: "WAXUSDC",
        contract: "eth.token",
        decimals: 6,
        alcorId: "waxusdc-eth.token",
        poolId: 1,
        waxPerToken: 50,
        usdPrice: 1,
        tvlUsd: 400,
        stable: true,
      },
    ],
  };
}

describe("advisor", () => {
  it("lists WAX and stables as quote tokens", () => {
    const q = listQuoteTokens(snap());
    expect(q).toContain("WAX");
    expect(q).toContain("WAXUSDC");
    expect(q).toContain("PARAUSD");
    expect(q).not.toContain("LEEF");
  });

  it("never lists WAX as a base or LEEF as a quote", () => {
    expect(listBaseTokens(snap())).not.toContain("WAX");
    expect(listQuoteTokens(snap(), "LEEF")).not.toContain("LEEF");
  });

  it("keeps USD min as floor and USD max as ceiling from wallet value", () => {
    const s = suggestBotSettings({
      snap: snap(),
      balances: { WAX: 200 },
      base: "LEEF",
      quote: "WAX",
      focus: ["LEEF", "WAX"],
      strategy: "signal",
      cpuPct: 0.2,
      netPct: 0.1,
      ramPct: 0.3,
    });
    expect(s.risk.minTradeUsd).toBeGreaterThanOrEqual(0);
    expect(s.risk.maxPositionUsd).toBeGreaterThanOrEqual(s.risk.minTradeUsd);
    expect(s.risk.maxPositionUsd).toBeLessThanOrEqual(200 * 0.02);
    expect(s.risk.minTradeUsd).toBeLessThan(s.risk.maxPositionUsd);
  });

  it("tightens size and cadence when CPU is exhausted", () => {
    const ok = suggestBotSettings({
      snap: snap(),
      balances: { WAX: 200 },
      base: "LEEF",
      quote: "WAX",
      focus: [],
      strategy: "signal",
      cpuPct: 0.2,
      netPct: 0.1,
      ramPct: 0.3,
    });
    const tight = suggestBotSettings({
      snap: snap(),
      balances: { WAX: 200 },
      base: "LEEF",
      quote: "WAX",
      focus: [],
      strategy: "signal",
      cpuPct: 0.96,
      netPct: 0.1,
      ramPct: 0.3,
    });
    expect(tight.risk.minTradeUsd).toBeLessThanOrEqual(ok.risk.minTradeUsd);
    expect(tight.risk.cooldownSec).toBeGreaterThan(ok.risk.cooldownSec);
    expect(tight.warnings.some((w) => /CPU/.test(w))).toBe(true);
  });

  it("does not mutate DEFAULT_RISK", () => {
    const before = { ...DEFAULT_RISK };
    suggestBotSettings({
      snap: snap(),
      balances: { WAX: 50 },
      base: "LEEF",
      quote: "WAX",
      focus: [],
      strategy: "dca",
      cpuPct: null,
      netPct: null,
      ramPct: null,
    });
    expect(DEFAULT_RISK).toEqual(before);
  });

  it("never suggests $1,000 exposure on a $50 wallet", () => {
    const s = suggestBotSettings({
      snap: snap(),
      balances: { WAX: 2_500 },
      base: "LEEF",
      quote: "WAX",
      focus: [],
      strategy: "signal",
      cpuPct: 0.1,
      netPct: 0.1,
      ramPct: 0.1,
    });
    expect(s.quoteUsd).toBeCloseTo(50, 6);
    expect(s.risk.maxPositionUsd).toBeLessThanOrEqual(50);
    expect(s.risk.maxPositionUsd).toBeLessThan(1_000);
  });

  it("caps a large wallet at the $1,000 product ceiling", () => {
    const s = suggestBotSettings({
      snap: snap(),
      balances: { WAX: 250_000 },
      base: "LEEF",
      quote: "WAX",
      focus: [],
      strategy: "signal",
      cpuPct: 0.1,
      netPct: 0.1,
      ramPct: 0.1,
    });
    expect(s.quoteUsd).toBeCloseTo(5_000, 4);
    expect(s.risk.maxPositionUsd).toBeLessThanOrEqual(1_000);
  });

  it("suggests a quote the wallet actually holds", () => {
    const pair = suggestPair(snap(), { WAXUSDC: 40, WAX: 1 }, ["LEEF", "WAXUSDC"]);
    expect(pair.base).toBe("LEEF");
    expect(pair.quote).toBe("WAXUSDC");
  });
});
