/**
 * Bounded-concurrency sharded venue sweeps (waxterminal lesson) and the
 * rounding-dust audit of the minOut memo flooring (roundingSafeMin).
 */
import { describe, expect, it, vi } from "vitest";

const { rpcPostMock } = vi.hoisted(() => ({ rpcPostMock: vi.fn() }));
vi.mock("@/lib/wallet/chain", () => ({ rpcPost: rpcPostMock }));

import {
  SWEEP_CONCURRENCY,
  defiboxMemo,
  fetchDefiboxPools,
  mapPool,
  tacoMemo,
} from "./venue-adapters";

function pairRow(id: number, waxQty = 1_000): Record<string, unknown> {
  return {
    id,
    token0: { contract: "eosio.token", symbol: "8,WAX" },
    token1: { contract: "leefmaincorp", symbol: "4,LEEF" },
    reserve0: `${waxQty.toFixed(8)} WAX`,
    reserve1: "10000000.0000 LEEF",
  };
}

type PageReq = { limit?: number; lower_bound?: number | string; upper_bound?: number };

/** In-memory pairs table with page semantics (and a concurrency tripwire). */
function serveTable(all: Record<string, unknown>[], opts: { ignoreUpper?: boolean } = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  rpcPostMock.mockImplementation(async (_path: string, body: PageReq) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight -= 1;
    const limit = body.limit ?? 200;
    const lower = Number(body.lower_bound ?? 0);
    const upper = opts.ignoreUpper ? null : (body.upper_bound ?? null);
    const eligible = all.filter(
      (r) =>
        Number(r.id) >= lower &&
        (upper == null || opts.ignoreUpper || Number(r.id) <= upper),
    );
    const page = eligible.slice(0, limit);
    const rest = eligible.slice(limit);
    return {
      rows: page,
      more: rest.length > 0,
      next_key: rest.length > 0 ? String(rest[0]!.id) : undefined,
    };
  });
  return {
    maxInFlight: () => maxInFlight,
    calls: () => rpcPostMock.mock.calls.length,
  };
}

describe("mapPool worker pool", () => {
  it("preserves order and never exceeds the in-flight bound", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 23 }, (_, i) => i);
    const out = await mapPool(items, 4, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, (n % 3) + 1));
      inFlight -= 1;
      return n * 2;
    });
    expect(out).toEqual(items.map((n) => n * 2));
    expect(maxInFlight).toBe(4);
  });
});

describe("sharded table sweeps", () => {
  it("sweeps all pages with bounded concurrency (not sequential)", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => pairRow(i + 1));
    const table = serveTable(rows);
    const pools = await fetchDefiboxPools(0.02);
    expect(pools).toHaveLength(600);
    expect(new Set(pools.map((p) => p.nativeId)).size).toBe(600); // no dupes
    expect(table.maxInFlight()).toBeGreaterThan(1); // actually parallel
    expect(table.maxInFlight()).toBeLessThanOrEqual(SWEEP_CONCURRENCY);
  });

  it("drops strays and dedupes rows a misbehaving node returns across shard bounds", async () => {
    // Ids straddling the 25k shard boundary; the node ignores upper_bound.
    const rows = [24998, 24999, 25000, 25001, 50000, 75001].map((id) => pairRow(id));
    serveTable(rows, { ignoreUpper: true });
    const pools = await fetchDefiboxPools(0.02);
    const ids = pools.map((p) => p.nativeId).sort((a, b) => a - b);
    expect(ids).toEqual([24998, 24999, 25000, 25001, 50000, 75001]);
  });

  it("still returns everything when a sweep shard is beyond the last id", async () => {
    serveTable([pairRow(7), pairRow(42)]);
    const pools = await fetchDefiboxPools(0.02);
    expect(pools.map((p) => p.nativeId).sort((a, b) => a - b)).toEqual([7, 42]);
  });
});

describe("minOut rounding dust (roundingSafeMin audit)", () => {
  /**
   * waxterminal's `roundingSafeMin` lesson: small swaps revert when the memo
   * demands one quantum more than the pool's integer math guarantees. Our
   * memo builders FLOOR the min-out to integer units (+1e-9 only to absorb
   * IEEE-754 dust like 12.3456×10⁴ = 123455.999…). Verify the gap is NOT
   * real here: the memo must never exceed the pool-guaranteed integer output
   * (worst case = our float quote is exactly the pool's real quote).
   */
  const dustProne = [
    12.3456, // classic binary dust case
    0.1 + 0.2,
    1 / 3,
    9999.99999999,
    100.00000000001,
    0.000042,
    5.960464477539063e-8,
    123456.7890123,
    1e-9,
    7.000000000000001,
  ];
  for (let i = 1; i <= 300; i++) dustProne.push(i / 7 + (i % 13) * 1e-9);

  it("defiboxMemo never demands more units than the pool-guaranteed out", () => {
    for (const amountOut of dustProne) {
      for (const slip of [0.001, 0.005, 0.03]) {
        for (const d of [0, 4, 8]) {
          const minOut = amountOut * (1 - slip);
          const memo = defiboxMemo(minOut, d, 12);
          const units = Number(memo.split(",")[1]);
          const poolGuaranteed = Math.floor(amountOut * 10 ** d);
          expect(units).toBeGreaterThanOrEqual(0);
          expect(units).toBeLessThanOrEqual(poolGuaranteed);
        }
      }
    }
  });

  it("tacoMemo never demands more units than the pool-guaranteed out", () => {
    for (const amountOut of dustProne) {
      for (const slip of [0.001, 0.005, 0.03]) {
        for (const d of [0, 4, 8]) {
          const minOut = amountOut * (1 - slip);
          const memo = tacoMemo(minOut, "LEEF", "leefmaincorp", d);
          const body = memo.split(" ")[0]!;
          const [whole, frac = ""] = body.split(".");
          const units = Number(whole) * 10 ** d + Number((frac + "0".repeat(d)).slice(0, d) || 0);
          const poolGuaranteed = Math.floor(amountOut * 10 ** d);
          expect(units).toBeGreaterThanOrEqual(0);
          expect(units).toBeLessThanOrEqual(poolGuaranteed);
        }
      }
    }
  });

  it("absorbs IEEE dust at exact integer boundaries (no quantum lost)", () => {
    // 12.3456 × 10⁴ is 123455.999… in binary — flooring raw would DROP a unit
    // the exact decimal value guarantees; the 1e-9 correction restores it.
    const memo = defiboxMemo(12.3456, 4, 12);
    expect(memo).toBe("swap,123456,12");
  });
});
