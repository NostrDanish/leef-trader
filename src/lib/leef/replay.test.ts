/**
 * Replay tests — Phase 3 market memory. Prove a route-scoped fixture
 * reproduces the decision path: same book in → same route and verdict out.
 */
import { describe, expect, it } from "vitest";
import type { MarketFixture } from "./journal";
import { rankExecutionRoutes } from "./route-optimizer";
import { replayAll, replayFixture, snapshotFromFixture } from "./replay";

const WAX_USD = 0.02;

/** The fixture twin of a 40,000 WAX × 400M LEEF pool (#217, 0.3% fee). */
function baseFixture(over: Partial<MarketFixture> = {}): MarketFixture {
  return {
    ts: 1_800_000_000_000,
    kind: "gate_veto",
    strategy: "auto",
    mode: "paper",
    tokenIn: "WAX",
    tokenOut: "LEEF",
    amountIn: 100,
    candidates: [
      {
        routeSig: "direct:217",
        poolIds: [217],
        amountOut: 994_522, // CP: 100×0.997×400M/(40,000+99.7)
        pass: false,
        netPct: -1.24,
      },
    ],
    pools: [
      {
        id: 217,
        venue: "alcor",
        aSym: "LEEF",
        aContract: "leefmaincorp",
        aQty: 400_000_000,
        aDec: 4,
        bSym: "WAX",
        bContract: "eosio.token",
        bQty: 40_000,
        bDec: 8,
        feePct: 0.3,
        tvlUsd: 1600,
      },
    ],
    prices: { WAX: WAX_USD, LEEF: 0.0001 * WAX_USD },
    waxUsd: WAX_USD,
    leefUsd: 0.0001 * WAX_USD,
    reason: "fixture",
    ...over,
  };
}

describe("snapshotFromFixture", () => {
  it("rebuilds a book that quotes identically to the original", () => {
    const fx = baseFixture();
    const snap = snapshotFromFixture(fx);
    const routes = rankExecutionRoutes(snap.pools, snap.aux, 100, "WAX", "LEEF");
    expect(routes).toHaveLength(1);
    expect(routes[0]!.poolIds).toEqual([217]);
    // 100 WAX less 0.3% fee into 40,000×400M CP → 99.7×400M/40,099.7
    expect(routes[0]!.amountOut).toBeCloseTo(994_522, -2);
  });
});

describe("replayFixture", () => {
  it("replays a swap-gate veto identically when logic and book are unchanged", () => {
    const fx = baseFixture({
      gate: {
        kind: "swap",
        expectedOut: 994_522,
        guaranteedOut: 990_000,
        minNetPct: 0,
        pass: false,
        netPct: -0.55,
      },
    });
    const r = replayFixture(fx);
    // 994,522 LEEF out for 100 WAX in, at par prices → ≈−0.55% net → FAIL both.
    expect(r.thenPass).toBe(false);
    expect(r.nowPass).toBe(false);
    expect(r.verdict).toBe("same");
  });

  it("detects a route change when the recorded winner no longer wins", () => {
    const fx = baseFixture();
    // Simulate "old code preferred a different route": record a winner that
    // isn't what the current router produces for this book.
    fx.candidates = [
      { routeSig: "hop:217>314>999", poolIds: [217, 314, 999], amountOut: 1, pass: false, netPct: -1 },
    ];
    const r = replayFixture(fx);
    expect(r.routeChanged).toBe(true);
    expect(r.verdict).toBe("route_changed");
  });

  it("finds no route on an empty fixture book", () => {
    const fx = baseFixture({ pools: [] });
    const r = replayFixture(fx);
    expect(r.nowRouteSig).toBeNull();
  });

  it("entry fixtures replay route ranking only (venue thesis never faked)", () => {
    const fx = baseFixture({
      gate: { kind: "entry", expectedOut: 994_522, minNetPct: 0.1, pass: false, netPct: -0.4 },
    });
    const r = replayFixture(fx);
    expect(r.nowPass).toBeNull();
    expect(r.reason).toContain("never faked");
  });

  it("replayAll summarizes a batch", () => {
    const { summary } = replayAll([
      baseFixture({
        gate: { kind: "swap", expectedOut: 994_522, guaranteedOut: 990_000, minNetPct: 0, pass: false, netPct: -0.55 },
      }),
      baseFixture({ ts: 1_800_000_100_000 }),
    ]);
    expect(summary.total).toBe(2);
    expect(summary.same + summary.routeChanged + summary.flipped + summary.notReplayable).toBe(2);
  });
});
