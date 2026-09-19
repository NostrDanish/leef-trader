import { describe, expect, it } from "vitest";
import { parseDefiboxPairs, defiboxMemo, tacoMemo } from "./venue-adapters";
import { DEFIBOX_ID_BASE, TACO_ID_BASE, tokenOk, venueOfPoolId } from "./venues";
import { bestExecutionRoute } from "./route-optimizer";
import type { AuxPool, LeefPool } from "./types";

describe("venue identity", () => {
  it("namespaces pool ids so venues never collide", () => {
    expect(venueOfPoolId(217)).toBe("alcor");
    expect(venueOfPoolId(DEFIBOX_ID_BASE + 12)).toBe("defibox");
    expect(venueOfPoolId(TACO_ID_BASE + 3)).toBe("taco");
  });

  it("rejects spoofed LEEF/WAX on venue books", () => {
    expect(tokenOk({ symbol: "LEEF", contract: "leefmaincorp" })).toBe(true);
    expect(tokenOk({ symbol: "LEEF", contract: "fake.leef" })).toBe(false);
    expect(tokenOk({ symbol: "WAX", contract: "eosio.token" })).toBe(true);
    expect(tokenOk({ symbol: "WAX", contract: "fake.wax" })).toBe(false);
  });
});

describe("defibox parser + memo", () => {
  it("parses swap.box pairs rows", () => {
    const pools = parseDefiboxPairs(
      [
        {
          id: 12,
          token0: { contract: "eosio.token", symbol: "8,WAX" },
          token1: { contract: "leefmaincorp", symbol: "4,LEEF" },
          reserve0: "1000.00000000 WAX",
          reserve1: "10000000.0000 LEEF",
        },
      ],
      0.02,
    );
    expect(pools).toHaveLength(1);
    expect(pools[0]!.venue).toBe("defibox");
    expect(pools[0]!.id).toBe(DEFIBOX_ID_BASE + 12);
    expect(pools[0]!.tokenA.symbol).toBe("WAX");
    expect(pools[0]!.tokenB.symbol).toBe("LEEF");
  });

  it("drops spoofed LEEF rows", () => {
    expect(
      parseDefiboxPairs(
        [
          {
            id: 1,
            token0: { contract: "eosio.token", symbol: "8,WAX" },
            token1: { contract: "token.leef", symbol: "4,LEEF" },
            reserve0: "1000.00000000 WAX",
            reserve1: "10000000.0000 LEEF",
          },
        ],
        0.02,
      ),
    ).toEqual([]);
  });

  it("builds the documented Defibox memo", () => {
    expect(defiboxMemo(12.3456, 4, 12)).toBe("swap,123456,12");
  });
});

describe("taco memo", () => {
  it("builds the on-chain observed Taco memo", () => {
    expect(tacoMemo(1.5, "WAX", "eosio.token", 8)).toBe("1.50000000 WAX@eosio.token");
  });
  it("truncates toward zero — never demands more than the pool quoted", () => {
    // toFixed(4) would emit 1.2346 (rounding UP above the quote → chain revert).
    expect(tacoMemo(1.23455, "LEEF", "leefmaincorp", 4)).toBe("1.2345 LEEF@leefmaincorp");
    expect(tacoMemo(0.999999999, "WAX", "eosio.token", 8)).toBe("0.99999999 WAX@eosio.token");
  });
});

function leefPool(id: number, wax: number, leef: number): LeefPool {
  return {
    id,
    fee: 3000,
    feePct: 0.3,
    leef: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: leef },
    pair: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: wax },
    leefIsA: true,
    tvlUsd: 100,
    volume24Usd: 10,
    volumeWeekUsd: 0,
    volumeUsdMonth: 0,
    volumeUsd90: 0,
    volumeLeef24: 0,
    volumePair24: 0,
    change24: 0,
    changeWeek: 0,
    liquidity: "0",
    pairPerLeef: wax / leef,
    leefPerPair: leef / wax,
    waxPerLeef: wax / leef,
    usdPerLeef: null,
    tickSpacing: 60,
  };
}

describe("cross-venue routing", () => {
  it("picks a deeper Defibox book over a thin Alcor direct", () => {
    const alcor = [leefPool(1, 80, 1_200_000)];
    const defibox: AuxPool = {
      id: DEFIBOX_ID_BASE + 12,
      fee: 3000,
      feePct: 0.3,
      tokenA: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: 50_000 },
      // Same 15,000 LEEF/WAX price as the thin Alcor book, 625× the depth —
      // depth (not a better price) is what must win here.
      tokenB: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: 750_000_000 },
      tvlUsd: 2000,
      volume24Usd: 0,
      venue: "defibox",
    };
    const r = bestExecutionRoute(alcor, [defibox], 10, "WAX", "LEEF")!;
    expect(r.poolIds[0]).toBe(DEFIBOX_ID_BASE + 12);
    expect(r.legs[0]?.venue).toBe("defibox");
  });

  it("keeps Alcor when it is the deeper book", () => {
    const alcor = [leefPool(2, 80_000, 800_000_000)];
    const taco: AuxPool = {
      id: TACO_ID_BASE + 1,
      fee: 3000,
      feePct: 0.3,
      tokenA: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: 40 },
      // Same 10,000 LEEF/WAX price as the deep Alcor book but dust-thin —
      // impact, not price, is what must lose here.
      tokenB: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: 400_000 },
      tvlUsd: 5,
      volume24Usd: 0,
      venue: "taco",
    };
    const r = bestExecutionRoute(alcor, [taco], 5, "WAX", "LEEF")!;
    expect(r.poolIds[0]).toBe(2);
  });

  it("drops spoofed LEEF on a venue book", () => {
    const fake: AuxPool = {
      id: DEFIBOX_ID_BASE + 99,
      fee: 3000,
      feePct: 0.3,
      tokenA: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: 50_000 },
      tokenB: { symbol: "LEEF", contract: "token.leef", decimals: 4, quantity: 500_000_000 },
      tvlUsd: 2000,
      volume24Usd: 0,
      venue: "defibox",
    };
    expect(bestExecutionRoute([], [fake], 10, "WAX", "LEEF")).toBeNull();
  });
});
