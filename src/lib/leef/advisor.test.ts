import { describe, expect, it } from "vitest";
import { listQuoteTokens, suggestBotSettings } from "./advisor";
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
  });

  it("keeps clip as floor and max as ceiling from wallet size", () => {
    const s = suggestBotSettings({
      snap: snap(),
      balances: { WAX: 200 },
      quote: "WAX",
      strategy: "signal",
      cpuPct: 0.2,
      netPct: 0.1,
      ramPct: 0.3,
    });
    expect(s.risk.clipWax).toBeGreaterThanOrEqual(0.1);
    expect(s.risk.maxPositionWax).toBeGreaterThanOrEqual(s.risk.clipWax);
    expect(s.risk.maxPositionWax).toBeLessThanOrEqual(200);
    expect(s.risk.clipWax).toBeLessThan(s.risk.maxPositionWax);
  });

  it("tightens size and cadence when CPU is exhausted", () => {
    const ok = suggestBotSettings({
      snap: snap(),
      balances: { WAX: 200 },
      quote: "WAX",
      strategy: "signal",
      cpuPct: 0.2,
      netPct: 0.1,
      ramPct: 0.3,
    });
    const tight = suggestBotSettings({
      snap: snap(),
      balances: { WAX: 200 },
      quote: "WAX",
      strategy: "signal",
      cpuPct: 0.96,
      netPct: 0.1,
      ramPct: 0.3,
    });
    expect(tight.risk.clipWax).toBeLessThanOrEqual(ok.risk.clipWax);
    expect(tight.risk.cooldownSec).toBeGreaterThan(ok.risk.cooldownSec);
    expect(tight.warnings.some((w) => /CPU/.test(w))).toBe(true);
  });

  it("does not mutate DEFAULT_RISK", () => {
    const before = { ...DEFAULT_RISK };
    suggestBotSettings({
      snap: snap(),
      balances: { WAX: 50 },
      quote: "WAX",
      strategy: "dca",
      cpuPct: null,
      netPct: null,
      ramPct: null,
    });
    expect(DEFAULT_RISK).toEqual(before);
  });
});
