/**
 * Regression: the route-level guaranteed output must come from
 * combineGuaranteedOut — split slices SUM their min-outs; hop chains take
 * the FINAL leg's min-out. A caller re-deriving this by hand got it wrong
 * (last-leg-only for splits), which understated the worst case 100+80 → 80.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { rpcPostMock } = vi.hoisted(() => ({ rpcPostMock: vi.fn() }));
vi.mock("@/lib/wallet/chain", () => ({ rpcPost: rpcPostMock }));

import { combineGuaranteedOut, routeVenueImpactPct, verifyExecutableRoute } from "./quote-verify";
import { exactSwapVerdict } from "./exact-gate";
import { neftyPairNativeId } from "./venue-adapters";
import { NEFTY_ID_BASE } from "./venues";
import type { LeefSnapshot, SwapRoute } from "./types";

const WAX_USD = 0.02;

function snap(): LeefSnapshot {
  const leefUsd = 0.0001 * WAX_USD;
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    waxUsd: WAX_USD,
    leefUsd,
    waxPerLeef: 0.0001,
    pools: [],
    aux: [],
    trades: [],
    universe: [
      {
        symbol: "WAX", contract: "eosio.token", decimals: 8, alcorId: "wax-eosio.token",
        poolId: 0, waxPerToken: 1, usdPrice: WAX_USD, tvlUsd: 1_000_000, stable: false,
      },
      {
        symbol: "LEEF", contract: "leefmaincorp", decimals: 4, alcorId: "leef-leefmaincorp",
        poolId: 1159, waxPerToken: 0.0001, usdPrice: leefUsd, tvlUsd: 50_000, stable: false,
      },
    ],
  };
}

function route(amountIn: number, amountOut: number): SwapRoute {
  return {
    id: "t", kind: "direct", label: "t", poolIds: [1159],
    legs: [{ poolId: 1159, pairName: "t", tokenIn: "WAX", tokenOut: "LEEF", amountIn, amountOut, feePct: 0.3, priceImpact: 0.001 }],
    amountIn, amountOut, tokenIn: "WAX", tokenOut: "LEEF",
    feePct: 0.3, priceImpact: 0.001, executionPrice: amountOut / amountIn,
    spotPrice: amountOut / amountIn, vsBestPct: 0, tvlUsd: 50_000, volume24Usd: 100, notes: [],
  };
}

describe("combineGuaranteedOut", () => {
  it("split route: guaranteed = SUM of leg min-outs", () => {
    const legs = [{ minOut: 100 }, { minOut: 80 }];
    expect(combineGuaranteedOut(legs, true)).toBe(180);
  });

  it("hop chain: guaranteed = final leg min-out (legs chain on guarantees)", () => {
    const legs = [{ minOut: 98.7 }, { minOut: 96.2 }];
    expect(combineGuaranteedOut(legs, false)).toBe(96.2);
  });

  it("single leg works for both shapes", () => {
    const legs = [{ minOut: 42.5 }];
    expect(combineGuaranteedOut(legs, true)).toBe(42.5);
    expect(combineGuaranteedOut(legs, false)).toBe(42.5);
  });

  it("empty route guarantees nothing", () => {
    expect(combineGuaranteedOut([], true)).toBe(0);
    expect(combineGuaranteedOut([], false)).toBe(0);
  });

  it("three-way split sums all three", () => {
    const legs = [{ minOut: 10 }, { minOut: 20 }, { minOut: 30 }];
    expect(combineGuaranteedOut(legs, true)).toBe(60);
  });
});

describe("routeVenueImpactPct (P-B)", () => {
  it("passes a single leg's venue impact through", () => {
    expect(routeVenueImpactPct([{ venueImpactPct: 0.42 }])).toBeCloseTo(0.42, 10);
  });

  it("compounds multi-leg impacts like combineImpact", () => {
    // 1 − (1−0.01)(1−0.02) = 2.98%.
    expect(routeVenueImpactPct([{ venueImpactPct: 1 }, { venueImpactPct: 2 }])).toBeCloseTo(2.98, 10);
  });

  it("ignores legs without a venue impact; undefined when none reported", () => {
    expect(routeVenueImpactPct([{ venueImpactPct: 0.5 }, {}])).toBeCloseTo(0.5, 10);
    expect(routeVenueImpactPct([{}, {}])).toBeUndefined();
    expect(routeVenueImpactPct([])).toBeUndefined();
  });
});

describe("verifyExecutableRoute — minReceived fail-closed (C1)", () => {
  const ACCOUNT = "trader.leef";

  function routerQuote(minReceived: string) {
    return {
      route: [1159],
      memo: `swapexactin#1159#${ACCOUNT}#${minReceived || "238000.0000 LEEF"}@leefmaincorp#0`,
      swaps: [
        {
          input: "10.00000000 WAX",
          route: [1159],
          output: "240000.0000 LEEF",
          percent: 100,
          memo: `swapexactin#1159#${ACCOUNT}#238000.0000 LEEF@leefmaincorp#0`,
          maxSent: "10.00000000 WAX",
          minReceived: "238000.0000 LEEF",
        },
      ],
      input: "10.00000000 WAX",
      output: "240000.0000 LEEF",
      minReceived,
      maxSent: "10.00000000 WAX",
      priceImpact: "0.12",
    };
  }

  function stubRouter(quote: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(quote), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a legitimate quote still passes and guarantees its minReceived", async () => {
    stubRouter(routerQuote("238000.0000 LEEF"));
    const v = await verifyExecutableRoute({
      route: route(10, 240_000),
      amountIn: 10,
      slippagePct: 0.5,
      account: ACCOUNT,
      snap: snap(),
      deadlineMs: 4_000,
    });
    expect(v.trust).toBe("executable");
    expect(v.exactness).toBe("exact");
    expect(v.guaranteedOut).toBeCloseTo(238_000, 4);
  });

  it("a missing minReceived fails closed — the guarantee is never fabricated", async () => {
    stubRouter(routerQuote(""));
    // Distinct amount → distinct quote-cache key (the cache is module-level).
    await expect(
      verifyExecutableRoute({
        route: route(11, 264_000),
        amountIn: 11,
        slippagePct: 0.5,
        account: ACCOUNT,
        snap: snap(),
        deadlineMs: 4_000,
      }),
    ).rejects.toThrow(/min-out guarantee/);
  });

  it("a zero minReceived fails closed", async () => {
    stubRouter(routerQuote("0.0000 LEEF"));
    await expect(
      verifyExecutableRoute({
        route: route(12, 288_000),
        amountIn: 12,
        slippagePct: 0.5,
        account: ACCOUNT,
        snap: snap(),
        deadlineMs: 4_000,
      }),
    ).rejects.toThrow(/min-out guarantee/);
  });
});

describe("exactSwapVerdict floor tolerance", () => {
  it("guaranteed below floor FAILS by default — the floor is a floor", () => {
    // exact +0.5%, but guaranteed (min-out) −0.1% vs a 0% floor.
    const v = exactSwapVerdict({
      snap: snap(),
      route: route(100, 100.5 * 10_000),
      amountIn: 100,
      expectedOut: 100.5 * 10_000,
      guaranteedOut: 99.9 * 10_000,
      minNetPct: 0,
    });
    expect(v.pass).toBe(false);
  });

  it("explicit tolerance parameter allows the stated dip only", () => {
    const opts = {
      snap: snap(),
      route: route(100, 100.5 * 10_000),
      amountIn: 100,
      expectedOut: 100.5 * 10_000,
      guaranteedOut: 99.9 * 10_000,
      minNetPct: 0,
    };
    expect(exactSwapVerdict({ ...opts, floorTolerancePct: 0.2 }).pass).toBe(true);
    expect(exactSwapVerdict({ ...opts, floorTolerancePct: 0.05 }).pass).toBe(false);
  });
});

describe("verifyExecutableRoute — Nefty leg (fresh_model)", () => {
  const ACCOUNT = "trader.leef";
  /** Real swap.nefty pairs row (ANON/WAX), fetched 2026-09-23. */
  const ANOWAX_ROW = {
    code: "ANOWAX",
    active: 1,
    reserve0: { quantity: "163650872.4567 ANON", contract: "anoncoin.gm" },
    reserve1: { quantity: "22171.79774480 WAX", contract: "eosio.token" },
    total_liquidity: "1595751521734",
  };
  const POOL_ID = NEFTY_ID_BASE + neftyPairNativeId("ANOWAX");

  function neftySnap(): LeefSnapshot {
    const base = snap();
    return {
      ...base,
      aux: [
        {
          id: POOL_ID,
          fee: 3000,
          feePct: 0.3,
          tokenA: { symbol: "ANON", contract: "anoncoin.gm", decimals: 4, quantity: 163650872.4567 },
          tokenB: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: 22171.79774480 },
          tvlUsd: 1000,
          volume24Usd: 0,
          venue: "nefty",
        },
      ],
      universe: [
        ...base.universe,
        {
          symbol: "ANON", contract: "anoncoin.gm", decimals: 4, alcorId: "anon-anoncoin.gm",
          poolId: 0, waxPerToken: 0.0001, usdPrice: 0.000002, tvlUsd: 1000, stable: false,
        },
      ],
      venues: [
        {
          venue: "nefty",
          id: POOL_ID,
          nativeId: neftyPairNativeId("ANOWAX"),
          pairCode: "ANOWAX",
          tokenA: { symbol: "ANON", contract: "anoncoin.gm", decimals: 4, quantity: 163650872.4567 },
          tokenB: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: 22171.79774480 },
          fee: 3000,
          feePct: 0.3,
          tvlUsd: 1000,
        },
      ],
    };
  }

  function neftyRoute(amountIn: number, amountOut: number): SwapRoute {
    return {
      id: "n", kind: "direct", label: "n", poolIds: [POOL_ID],
      legs: [{ poolId: POOL_ID, pairName: "n", tokenIn: "ANON", tokenOut: "WAX", amountIn, amountOut, feePct: 0.3, priceImpact: 0.001, venue: "nefty" }],
      amountIn, amountOut, tokenIn: "ANON", tokenOut: "WAX",
      feePct: 0.3, priceImpact: 0.001, executionPrice: amountOut / amountIn,
      spotPrice: amountOut / amountIn, vsBestPct: 0, tvlUsd: 1000, volume24Usd: 0, notes: [],
    };
  }

  function stubNeftyRows(rows: unknown[]) {
    rpcPostMock.mockImplementation(async (_path: string, body: Record<string, unknown>) => {
      if (body.table === "configs") {
        return { rows: [{ key: "fee.protocol", value: 10 }, { key: "fee.trade", value: 20 }] };
      }
      return { rows };
    });
  }

  afterEach(() => {
    rpcPostMock.mockReset();
  });

  it("verifies a Nefty leg from a fresh pair row and pins the swap:<CODE>,min: memo", async () => {
    stubNeftyRows([ANOWAX_ROW]);
    // CP at 0.3% over the row reserves: 10000 ANON → 1.35067631… WAX.
    const v = await verifyExecutableRoute({
      route: neftyRoute(10_000, 1.35067631),
      amountIn: 10_000,
      slippagePct: 0.5,
      account: ACCOUNT,
      snap: neftySnap(),
      deadlineMs: 4_000,
    });
    expect(v.trust).toBe("executable");
    expect(v.exactness).toBe("fresh_model");
    expect(v.expectedOut).toBeCloseTo(1.35067631, 6);
    // Dust-safe min-out: quantized slippage floor, enforced in the memo.
    expect(v.guaranteedOut).toBeCloseTo(1.34392293, 8);
    expect(v.verified[0]!.memo).toBe(`swap:ANOWAX,min:${Math.floor(1.34392293e8)}`);
    expect(v.verified[0]!.memo).toBe("swap:ANOWAX,min:134392293");
  });

  it("fails closed when the snapshot carries no pair code for the pool", async () => {
    stubNeftyRows([ANOWAX_ROW]);
    const s = { ...neftySnap(), venues: [] };
    await expect(
      verifyExecutableRoute({
        route: neftyRoute(10_000, 1.35067631),
        amountIn: 10_000,
        slippagePct: 0.5,
        account: ACCOUNT,
        snap: s,
        deadlineMs: 4_000,
      }),
    ).rejects.toThrow(/no discovered pair code/);
  });

  it("fails closed when fresh reserves drift > 8% from the candidate quote", async () => {
    stubNeftyRows([ANOWAX_ROW]);
    await expect(
      verifyExecutableRoute({
        route: neftyRoute(10_000, 1.8), // modeled 33% richer than fresh CP
        amountIn: 10_000,
        slippagePct: 0.5,
        account: ACCOUNT,
        snap: neftySnap(),
        deadlineMs: 4_000,
      }),
    ).rejects.toThrow(/reserves moved/);
  });

  it("fails closed when the fresh row is missing (pool vanished)", async () => {
    stubNeftyRows([]);
    await expect(
      verifyExecutableRoute({
        route: neftyRoute(10_000, 1.35067631),
        amountIn: 10_000,
        slippagePct: 0.5,
        account: ACCOUNT,
        snap: neftySnap(),
        deadlineMs: 4_000,
      }),
    ).rejects.toThrow(/no fresh on-chain quote/);
  });
});

describe("verifyExecutableRoute — dust min-out (roundingSafeMin)", () => {
  const ACCOUNT = "trader.leef";

  function dustQuote(minReceived: string) {
    return {
      route: [1159],
      memo: `swapexactin#1159#${ACCOUNT}#${minReceived || "0.0000 LEEF"}@leefmaincorp#0`,
      swaps: [
        {
          input: "0.00000100 WAX",
          route: [1159],
          output: "0.0500 LEEF",
          percent: 100,
          memo: `swapexactin#1159#${ACCOUNT}#0.0000 LEEF@leefmaincorp#0`,
          maxSent: "0.00000100 WAX",
          minReceived: "0.0000 LEEF",
        },
      ],
      input: "0.00000100 WAX",
      output: "0.0500 LEEF",
      minReceived,
      maxSent: "0.00000100 WAX",
      priceImpact: "0.01",
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a dust output with a zero router min verifies at a 1-unit ask instead of failing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(dustQuote("0.0000 LEEF")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const v = await verifyExecutableRoute({
      route: route(0.000001, 0.05), // 500 raw units of LEEF → dust
      amountIn: 0.000001,
      slippagePct: 0.5,
      account: ACCOUNT,
      snap: snap(),
      deadlineMs: 4_000,
    });
    // The ask is exactly 1 raw unit — the same number sign.ts rewrites into
    // the memo and the C1 floor checks. Never fabricated above that.
    expect(v.guaranteedOut).toBe(0.0001);
    expect(v.verified[0]!.minOut).toBe(0.0001);
  });
});
