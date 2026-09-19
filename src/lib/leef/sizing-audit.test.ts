/**
 * Audit evidence tests — docs/AI_LEARNING_SIZE_AUDIT.md.
 *
 * Every test here exists to PROVE a specific audit claim with deterministic
 * fixtures run through the real engine code (no mocks of the math). The
 * report cites these test names; if a test is deleted or weakened, the
 * audit claim falls with it.
 */
import { describe, expect, it } from "vitest";
import { quoteConstantProduct } from "./amm";
import { findBestArb } from "./bot-engine";
import {
  DEFAULT_COSTS,
  estimateRoundTripCosts,
  executionCostPct,
} from "./cost-model";
import { exactSwapVerdict } from "./exact-gate";
import { evaluateEntry, optimizeEntrySize } from "./net-edge";
import { rankExecutionRoutes } from "./route-optimizer";
import { classifyTradeError, isEconomicFailureCode, TradeError } from "@/lib/wallet/trade-error";
import type { AuxPool, LeefPool, LeefSnapshot } from "./types";

const WAX_USD = 0.02;

/** One exact CP LEEF/WAX pool, 0.3% fee. */
function mkPool(id: number, waxReserve: number, leefReserve: number): LeefPool {
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

function uniToken(symbol: string, contract: string, usdPrice: number) {
  return {
    symbol,
    contract,
    decimals: 4,
    alcorId: `${symbol.toLowerCase()}-${contract}`,
    poolId: 1,
    waxPerToken: usdPrice / WAX_USD,
    usdPrice,
    tvlUsd: 1000,
    stable: false,
  };
}

function mkSnap(pools: LeefPool[], aux: AuxPool[] = [], extraTokens: ReturnType<typeof uniToken>[] = []): LeefSnapshot {
  const waxPerLeef = pools[0]?.waxPerLeef ?? 0;
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    waxUsd: WAX_USD,
    leefUsd: waxPerLeef * WAX_USD,
    waxPerLeef,
    pools,
    aux,
    trades: [],
    universe: [
      { ...uniToken("WAX", "eosio.token", WAX_USD), decimals: 8, poolId: 0, waxPerToken: 1, tvlUsd: 1_000_000 },
      uniToken("LEEF", "leefmaincorp", waxPerLeef * WAX_USD),
      ...extraTokens,
    ],
  };
}

function auxPool(id: number, symA: string, qtyA: number, symB: string, qtyB: number): AuxPool {
  // Contract identity matters: buildRouteGraph rejects WAX-symbol tokens not
  // issued by eosio.token (spoof guard), so fixtures must use real contracts.
  const contractOf = (s: string) =>
    s === "WAX" ? "eosio.token"
    : s === "LEEF" ? "leefmaincorp"
    : s === "WAXUSDC" ? "eth.token"
    : `${s.toLowerCase()}.tok`;
  return {
    id,
    fee: 3000,
    feePct: 0.3,
    tokenA: { symbol: symA, contract: contractOf(symA), decimals: 4, quantity: qtyA },
    tokenB: { symbol: symB, contract: contractOf(symB), decimals: 4, quantity: qtyB },
    tvlUsd: qtyA * WAX_USD * 2,
    volume24Usd: 10,
  };
}

/* ------------------------------------------------------------------ */
/* §3 — sizing is an argmax over net profit, not a midpoint/default     */
/* ------------------------------------------------------------------ */

describe("§3 size optimization — non-midpoint optimum", () => {
  // Pool: 50,000 WAX × 500M LEEF. Band: 5–500 WAX ($0.10–$10). Edge 2%.
  // Net profit N(x) ≈ 0.02x·(2 − 0.65 − 0.004x)/100 is concave with an
  // interior maximum near x ≈ 169 WAX (~$3.38) — below the band midpoint
  // (252.5 WAX, $5.05) and far below the max ($10).
  const snap = mkSnap([mkPool(1159, 50_000, 500_000_000)]);
  const base = {
    snap,
    tokenIn: "WAX",
    tokenOut: "LEEF",
    expectedGrossPct: 2,
    minNetEdgePct: 0,
    volPerSec: 0,
  };

  it("selects a size that is neither the band midpoint nor the max", () => {
    const res = optimizeEntrySize({ ...base, minIn: 5, maxIn: 500 });
    expect(res).not.toBeNull();
    const best = res!.best;
    const midpoint = 252.5;
    expect(best.amountIn).toBeGreaterThan(100);
    expect(best.amountIn).toBeLessThan(230); // interior optimum, < midpoint
    expect(Math.abs(best.amountIn - midpoint)).toBeGreaterThan(20);
    expect(best.amountIn).toBeLessThan(500); // never blindly the max
    // The max-size candidate was evaluated and is strictly worse.
    const atMax = res!.tried.find((t) => Math.abs(t.amountIn - 500) < 1e-6);
    expect(atMax).toBeDefined();
    expect(atMax!.netProfitUsd).toBeLessThan(best.netProfitUsd);
    // The midpoint probe was evaluated and is strictly worse.
    const atMid = res!.tried.find((t) => Math.abs(t.amountIn - 252.5) < 1e-6);
    expect(atMid).toBeDefined();
    expect(atMid!.netProfitUsd).toBeLessThan(best.netProfitUsd);
  });

  it("can choose $0.20 or HOLD: micro band picks the floor, bad edge HOLDs", () => {
    // Same book, tiny band: floor $0.20 (10 WAX) is the best (and only sane) size.
    const micro = optimizeEntrySize({ ...base, minIn: 10, maxIn: 12 });
    expect(micro).not.toBeNull();
    expect(micro!.best.amountIn).toBeLessThanOrEqual(12);
    expect(micro!.best.notionalUsd).toBeLessThan(0.25);
    // Negative-edge thesis: no size clears the floor → null → HOLD.
    const nothing = optimizeEntrySize({ ...base, expectedGrossPct: 0.5, minIn: 5, maxIn: 500 });
    expect(nothing).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* §4 — micro-pool: tiny size accepted, big size rejected economically  */
/* ------------------------------------------------------------------ */

describe("§4 micro-pool — $0.20 wins where $5 loses", () => {
  // Pool: 2,000 WAX × 20M LEEF. 10 WAX ($0.20) ≈ 0.5% impact;
  // 250 WAX ($5) ≈ 11% impact. Edge 2%.
  const snap = mkSnap([mkPool(77, 2_000, 20_000_000)]);
  const base = {
    snap,
    tokenIn: "WAX",
    tokenOut: "LEEF",
    expectedGrossPct: 2,
    minNetEdgePct: 0,
    volPerSec: 0,
  };

  it("the optimizer chooses the $0.20-scale trade on a tiny pool", () => {
    const res = optimizeEntrySize({ ...base, minIn: 10, maxIn: 250 });
    expect(res).not.toBeNull();
    expect(res!.best.amountIn).toBeLessThanOrEqual(12);
    expect(res!.best.notionalUsd).toBeLessThan(0.25);
    expect(res!.best.pass).toBe(true);
  });

  it("the $5 size is quoted but economically rejected", () => {
    const big = evaluateEntry({ ...base, amountIn: 250 });
    expect(big).not.toBeNull(); // route EXISTS — the book can physically fill it
    expect(big!.pass).toBe(false); // …but its costs eat the thesis
    expect(big!.netProfitUsd).toBeLessThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* §5 — multi-hop bottleneck: the thinnest leg caps the route           */
/* ------------------------------------------------------------------ */

describe("§5 multi-hop bottleneck", () => {
  // WAX → AAA → BBB → WAXUSDC. Middle book 400/400 is the bottleneck.
  // Middle-leg floor: reserveIn ≥ 1.5× arriving → arriving ≤ 266.67 AAA,
  // i.e. ≈ 268 WAX in. The outer books are 10,000 deep and could take 10×
  // more — proof the route is NOT sized from the strongest pool.
  // CCC (not a trusted stable) prices at the pool observation — a WAXUSDC
  // endpoint would be re-anchored to its $1 peg by the oracle and break the
  // 1:1:1 fixture economics.
  const hopTokens = [
    uniToken("AAA", "aaa.tok", WAX_USD),
    uniToken("BBB", "bbb.tok", WAX_USD),
    uniToken("CCC", "ccc.tok", WAX_USD),
  ];
  const thin = mkSnap(
    [],
    [
      auxPool(201, "WAX", 10_000, "AAA", 10_000),
      auxPool(202, "AAA", 400, "BBB", 400),
      auxPool(203, "BBB", 10_000, "CCC", 10_000),
    ],
    hopTokens,
  );
  const base = {
    tokenIn: "WAX",
    tokenOut: "CCC",
    expectedGrossPct: 8,
    minNetEdgePct: 0,
    volPerSec: 0,
  };

  it("a 3-hop route exists and is found at small size", () => {
    const v = evaluateEntry({ ...base, snap: thin, amountIn: 5 });
    expect(v).not.toBeNull();
    expect(v!.route.legs.length).toBe(3);
    expect(v!.route.poolIds).toEqual([201, 202, 203]);
  });

  it("the bottleneck leg makes an oversized route UNQUOTABLE (not merely worse)", () => {
    // 450 WAX ≈ 429 AAA arriving > 266.67 allowed by the 400-deep middle book.
    expect(evaluateEntry({ ...base, snap: thin, amountIn: 450 })).toBeNull();
  });

  it("control: with a deep middle book the same size IS quotable (fails only on economics)", () => {
    const deep = mkSnap(
      [],
      [
        auxPool(201, "WAX", 10_000, "AAA", 10_000),
        auxPool(202, "AAA", 10_000, "BBB", 10_000),
        auxPool(203, "BBB", 10_000, "CCC", 10_000),
      ],
      hopTokens,
    );
    const v = evaluateEntry({ ...base, snap: deep, amountIn: 450 });
    expect(v).not.toBeNull();
    expect(v!.pass).toBe(false); // three hops of fees+impact eat the 8% thesis
  });

  it("optimal size on the bottlenecked route stays under the bottleneck cap", () => {
    const res = optimizeEntrySize({ ...base, snap: thin, minIn: 5, maxIn: 500 });
    expect(res).not.toBeNull();
    expect(res!.best.amountIn).toBeLessThanOrEqual(268.5);
    expect(res!.best.route.legs.length).toBe(3);
    // No evaluated candidate exceeded what the middle book can quote.
    expect(res!.tried.every((t) => t.amountIn <= 268.5)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* §6 — venue fee counted exactly once                                  */
/* ------------------------------------------------------------------ */

describe("§6 pool fee — counted once, never twice", () => {
  // Pool 1M WAX × 1M LEEF (spot 1:1 in WAX terms), 0.3% fee. (1M LEEF is the
  // route-graph depth floor; the 1:100 in:reserve ratio keeps the numbers
  // identical to a 10k×10k book at 100 in.)
  // 10,000 WAX in → out = 9970·1e6/(1e6+9970) = 9,871.55 LEEF.
  // executionCostPct vs USD mids = 1.2845% = fee (0.3) + curve impact (0.985),
  // measured from the quote — so the fee is inside amountOut, once.
  const snap = mkSnap([mkPool(55, 1_000_000, 1_000_000)]);

  it("execution cost ≈ fee + impact, single-counted", () => {
    const route = rankExecutionRoutes(snap.pools, snap.aux, 10_000, "WAX", "LEEF")[0]!;
    expect(route.feePct).toBeCloseTo(0.3, 6);
    const cost = executionCostPct(route, snap);
    expect(cost).toBeGreaterThan(1.26);
    expect(cost).toBeLessThan(1.31);
    // If the model charged the 0.3% fee AGAIN on top of the quote, cost
    // would jump by ~0.3pp. It does not.
    const doubleCounted = executionCostPct({ ...route, amountOut: route.amountOut * 0.997 }, snap);
    expect(doubleCounted).toBeGreaterThan(cost + 0.25);
  });

  it("quoteConstantProduct deducts the fee from input exactly once", () => {
    const q = quoteConstantProduct(100, 10_000, 10_000, 3000);
    expect(q.feePaid).toBeCloseTo(0.3, 9); // 0.3% of 100
    expect(q.amountOut).toBeCloseTo(98.7155, 3);
    // priceImpact excludes the fee (measured against fee-adjusted spot):
    expect(q.priceImpact).toBeCloseTo(0.00985, 4);
  });
});

/* ------------------------------------------------------------------ */
/* §7 — expected slippage (economics) ≠ min-out protection (safety)      */
/* ------------------------------------------------------------------ */

describe("§7 slippage separation", () => {
  const snap = mkSnap([mkPool(55, 1_000_000, 1_000_000)]);

  it("the cost model's slippage allowance never touches the route quote", () => {
    const route = rankExecutionRoutes(snap.pools, snap.aux, 10_000, "WAX", "LEEF")[0]!;
    const a = estimateRoundTripCosts({ route, exitRoute: null, snap, volPerSec: 0 });
    const b = estimateRoundTripCosts({
      route,
      exitRoute: null,
      snap,
      volPerSec: 0,
      config: { ...DEFAULT_COSTS, slippageBufferPct: 2 },
    });
    // Widening the EXPECTED-cost allowance changes slippagePct only…
    expect(b.slippagePct).toBeCloseTo(2, 9);
    expect(a.slippagePct).toBeCloseTo(DEFAULT_COSTS.slippageBufferPct, 9);
    // …and cannot move the measured execution cost (fee+impact) at all.
    expect(b.execInPct).toBeCloseTo(a.execInPct, 12);
    expect(b.execOutPct).toBeCloseTo(a.execOutPct, 12);
  });
});

/* ------------------------------------------------------------------ */
/* §11 — failure classification: infrastructure never teaches the market */
/* ------------------------------------------------------------------ */

describe("§11 failure classification", () => {
  it("economic failures teach the danger score", () => {
    expect(isEconomicFailureCode("MIN_OUT_FAILED")).toBe(true);
    expect(isEconomicFailureCode("SLIPPAGE_TOO_HIGH")).toBe(true);
    expect(isEconomicFailureCode("LIQUIDITY_CHANGED")).toBe(true);
    expect(isEconomicFailureCode("TRANSACTION_FAILED")).toBe(true);
  });

  it("infrastructure failures never teach the danger score", () => {
    expect(isEconomicFailureCode("RPC_FAILURE")).toBe(false);
    expect(isEconomicFailureCode("API_RATE_LIMIT")).toBe(false);
    expect(isEconomicFailureCode("VENUE_UNAVAILABLE")).toBe(false);
    expect(isEconomicFailureCode("INSUFFICIENT_CPU")).toBe(false);
    expect(isEconomicFailureCode("POLICY_BLOCK")).toBe(false);
  });

  it("the observed sweep CPU revert classifies as infrastructure, not market", () => {
    // The real 2026-09-16 failure body (tx_cpu_usage_exceeded, HTTP 500).
    const err = new Error(
      "WAX push_transaction | https://rpc | status=500 | body=" +
        JSON.stringify({
          error: {
            name: "tx_cpu_usage_exceeded",
            details: [{ message: "transaction exceeded failure limit for account x until 2026-09-16T10:11:13.000" }],
          },
        }),
    );
    const { code } = classifyTradeError(err);
    expect(code).toBe("RPC_FAILURE");
    expect(isEconomicFailureCode(code)).toBe(false);
  });

  it("an explicit min-out TradeError keeps its economic class", () => {
    const { code } = classifyTradeError(new TradeError("MIN_OUT_FAILED", "min-out breached"));
    expect(code).toBe("MIN_OUT_FAILED");
    expect(isEconomicFailureCode(code)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Cycles (round trips): discovered by the graph, floored at the gate    */
/* ------------------------------------------------------------------ */

describe("cycles — discovery and the no-loss floor", () => {
  // Mirrors the observed desk state: LEEF/WAX #217, LEEF/WUF #1713,
  // WUF/WAX #1656. First a FAIR ring (WUF priced 1 WAX on both books),
  // then a broken ring (WUF 125× richer on one book — the mirage shape).
  // #1713 always prices WUF at 10,000 LEEF (= 1 WAX). `richX` scales the
  // WAX side of #1656 — richX=125 makes WUF 125× dearer there (mirage ring).
  const mkCycleSnap = (richX: number) =>
    mkSnap(
      [mkPool(217, 40_000, 400_000_000)], // 10,000 LEEF per WAX
      [
        auxPool(1713, "LEEF", 8_000_000, "WUF", 800), // 10,000 LEEF per WUF
        auxPool(1656, "WUF", 800, "WAX", 800 * richX), // richX WAX per WUF
      ],
      [uniToken("WUF", "wuf.tok", WAX_USD)],
    );

  it("discovers the 3-hop LEEF→WUF→WAX→LEEF cycle", () => {
    const snap = mkCycleSnap(1);
    const routes = rankExecutionRoutes(snap.pools, snap.aux, 10_000, "LEEF", "LEEF");
    const cycle = routes.find((r) => r.legs.length === 3);
    expect(cycle).toBeDefined();
    expect(new Set(cycle!.poolIds)).toEqual(new Set([1713, 1656, 217]));
  });

  it("a fair ring returns LESS than the input after fees — never a fantasy", () => {
    const snap = mkCycleSnap(1);
    const cycle = rankExecutionRoutes(snap.pools, snap.aux, 10_000, "LEEF", "LEEF").find(
      (r) => r.legs.length === 3,
    )!;
    expect(cycle.amountOut).toBeLessThan(10_000);
    expect(cycle.amountOut).toBeGreaterThan(9_500); // ~0.9% fees + small impact
  });

  it("a broken ring still yields a cycle — the gate must do the refusing", () => {
    const snap = mkCycleSnap(125); // WUF 125× richer on #1656 than on #1713
    const cycle = rankExecutionRoutes(snap.pools, snap.aux, 10_000, "LEEF", "LEEF").find(
      (r) => r.legs.length === 3,
    )!;
    expect(cycle.amountOut).toBeGreaterThan(10_000); // local math sees the "profit"
  });

  it("the exact gate refuses a cycle whose venue-guaranteed output loses", () => {
    const snap = mkCycleSnap(1);
    const cycle = rankExecutionRoutes(snap.pools, snap.aux, 10_000, "LEEF", "LEEF").find(
      (r) => r.legs.length === 3,
    )!;
    const refuse = exactSwapVerdict({
      snap,
      route: cycle,
      amountIn: 10_000,
      expectedOut: 9_910, // venue says the ring is flat — fees only
      guaranteedOut: 9_910,
      minNetPct: 0,
    });
    expect(refuse.pass).toBe(false);
    const allow = exactSwapVerdict({
      snap,
      route: cycle,
      amountIn: 10_000,
      expectedOut: 10_400,
      guaranteedOut: 10_050, // worst case still wins
      minNetPct: 0,
    });
    expect(allow.pass).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* §12 — volume maker: bounded loss budget, never count-as-objective     */
/* ------------------------------------------------------------------ */

describe("§12 volume maker economics", () => {
  const snap = mkSnap([mkPool(1159, 50_000, 500_000_000)]);

  it("an echo inside the loss budget is found and is a BOUNDED loss", () => {
    const plan = findBestArb(snap, 50, -1.5, true, 1);
    expect(plan).not.toBeNull();
    expect(plan!.waxOut).toBeLessThan(plan!.waxIn); // costs money…
    const lossPct = (plan!.waxOut / plan!.waxIn - 1) * 100;
    expect(lossPct).toBeGreaterThanOrEqual(-1.5 - 1e-9); // …never beyond budget
  });

  it("with a profit floor the same flat book produces NOTHING", () => {
    // Same book, same sizes — but the floor is +0.3% profit. No plan exists:
    // the maker cannot print transactions when economics say no.
    expect(findBestArb(snap, 50, 0.3, true, 1)).toBeNull();
  });
});
