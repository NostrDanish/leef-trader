import { describe, expect, it } from "vitest";
import { bestExecutionRoute } from "./route-optimizer";
import { emptyTimings } from "@/lib/wallet/trade-cycle";
import type { LeefPool } from "./types";

function mkPool(id: number, wax: number, leef: number): LeefPool {
  const pairPerLeef = wax / leef;
  return {
    id,
    fee: 3000,
    feePct: 0.3,
    leef: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: leef },
    pair: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: wax },
    leefIsA: true,
    tvlUsd: wax * 0.04 * 2,
    volume24Usd: 10,
    volumeWeekUsd: 0,
    volumeUsdMonth: 0,
    volumeUsd90: 0,
    volumeLeef24: 0,
    volumePair24: 0,
    change24: 0,
    changeWeek: 0,
    liquidity: "0",
    pairPerLeef,
    leefPerPair: 1 / pairPerLeef,
    waxPerLeef: pairPerLeef,
    usdPerLeef: pairPerLeef * 0.04,
    tickSpacing: 60,
  };
}

describe("hot-path timings shape", () => {
  it("starts every cycle at zero", () => {
    const t = emptyTimings();
    expect(t.snapshotFetchMs).toBe(0);
    expect(t.totalTradeCycleMs).toBe(0);
    expect(Object.keys(t)).toEqual([
      "snapshotFetchMs",
      "poolRefreshMs",
      "tradeHistoryMs",
      "venueDiscoveryMs",
      "routeSearchMs",
      "netEdgeMs",
      "quoteMs",
      "policyMs",
      "signMs",
      "broadcastMs",
      "confirmationMs",
      "totalTradeCycleMs",
    ]);
  });
});

describe("route search (heap)", () => {
  it("finds a direct WAX→LEEF path in well under 50ms on a small book", () => {
    const pools = [mkPool(1, 50_000, 500_000_000), mkPool(2, 8_000, 90_000_000)];
    const t0 = Date.now();
    const route = bestExecutionRoute(pools, [], 10, "WAX", "LEEF");
    const ms = Date.now() - t0;
    expect(route).not.toBeNull();
    expect(route!.amountOut).toBeGreaterThan(0);
    expect(ms).toBeLessThan(50);
  });
});
