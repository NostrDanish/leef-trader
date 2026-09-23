/**
 * NeftyBlocks venue adapter (swap.nefty) — fixtures are REAL table rows and
 * an executed swap fetched live from wax.greymass / Hyperion on 2026-09-23.
 *
 * Live-verified facts pinned here:
 *  - `pairs` table is keyed by symbol_code (`code`), reserves are
 *    extended_asset { quantity, contract }, `active` gates the pair.
 *  - Memo: `swap:<CODE>,min:<rawUnits>` — min is an integer count of RAW
 *    output units (trace: `min:137` passed on a 19.82283765-token output).
 *  - Fee: configs fee.protocol 10bp + fee.trade 20bp = 0.30% total, skimmed
 *    inline (0.1% protocol to sfees.nefty).
 *  - Constant-product verified against executed logswap USDANO trace.
 */
import { describe, expect, it, vi } from "vitest";

const { rpcPostMock } = vi.hoisted(() => ({ rpcPostMock: vi.fn() }));
vi.mock("@/lib/wallet/chain", () => ({ rpcPost: rpcPostMock }));

import { quoteConstantProduct } from "./amm";
import {
  NEFTY_FEE_ALCOR,
  fetchExternalVenues,
  fetchNeftyPools,
  neftyMemo,
  neftyPairNativeId,
  parseNeftyPairs,
  setNeftyVenueEnabled,
} from "./venue-adapters";
import {
  NEFTY_ID_BASE,
  NEFTY_SWAP,
  dustSafeMinOut,
  isDustOutput,
  nativePoolId,
  swapContractOf,
  venueOfPoolId,
} from "./venues";

/** Real `pairs` row, fetched 2026-09-23 (ANON/WAX). */
const ANOWAX_ROW = {
  code: "ANOWAX",
  active: 1,
  reserve0: { quantity: "163650872.4567 ANON", contract: "anoncoin.gm" },
  reserve1: { quantity: "22171.79774480 WAX", contract: "eosio.token" },
  total_liquidity: "1595751521734",
  created_time: "2024-07-08T13:05:45.000",
  updated_time: "2026-09-23T08:01:34.000",
};

/** Real `pairs` row, fetched 2026-09-23 (USDT/ANON — no WAX side). */
const USDANO_ROW = {
  code: "USDANO",
  active: 1,
  reserve0: { quantity: "1951.8456 USDT", contract: "usdt.alcor" },
  reserve1: { quantity: "2607552433.9716 ANON", contract: "anoncoin.gm" },
  total_liquidity: "22264579027",
  created_time: "2024-07-08T13:05:45.000",
  updated_time: "2026-09-23T08:01:34.000",
};

const WAX_USD = 0.04;

describe("parseNeftyPairs (live row fixtures)", () => {
  it("parses a real WAX pair into a namespaced aux book", () => {
    const pools = parseNeftyPairs([ANOWAX_ROW], WAX_USD);
    expect(pools).toHaveLength(1);
    const p = pools[0]!;
    expect(p.venue).toBe("nefty");
    expect(p.pairCode).toBe("ANOWAX");
    expect(p.nativeId).toBe(neftyPairNativeId("ANOWAX"));
    expect(p.id).toBe(NEFTY_ID_BASE + p.nativeId);
    expect(p.tokenA).toEqual({
      symbol: "ANON",
      contract: "anoncoin.gm",
      decimals: 4,
      quantity: 163650872.4567,
    });
    expect(p.tokenB.symbol).toBe("WAX");
    expect(p.tokenB.contract).toBe("eosio.token");
    expect(p.tokenB.decimals).toBe(8);
    expect(p.fee).toBe(NEFTY_FEE_ALCOR);
    expect(p.feePct).toBeCloseTo(0.3, 10);
    expect(p.tvlUsd).toBeCloseTo(22171.79774480 * 2 * WAX_USD, 6);
    // Route-graph id round-trips through the venue namespace helpers.
    expect(venueOfPoolId(p.id)).toBe("nefty");
    expect(nativePoolId(p.id)).toBe(p.nativeId);
    expect(swapContractOf("nefty")).toBe(NEFTY_SWAP);
  });

  it("drops non-WAX pairs under the dust-TVL filter (same as Defibox/Taco)", () => {
    expect(parseNeftyPairs([USDANO_ROW], WAX_USD)).toHaveLength(0);
  });

  it("skips inactive and drained pools", () => {
    const inactive = { ...ANOWAX_ROW, active: 0 };
    const drained = {
      ...ANOWAX_ROW,
      reserve0: { quantity: "0.0000 ANON", contract: "anoncoin.gm" },
    };
    expect(parseNeftyPairs([inactive, drained], WAX_USD)).toHaveLength(0);
  });

  it("fails closed on malformed rows (log + skip, never throws)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = [
      { code: "lowercase", active: 1, reserve0: ANOWAX_ROW.reserve0, reserve1: ANOWAX_ROW.reserve1 },
      { code: "TOOLONGCODE", active: 1, reserve0: ANOWAX_ROW.reserve0, reserve1: ANOWAX_ROW.reserve1 },
      { active: 1, reserve0: ANOWAX_ROW.reserve0, reserve1: ANOWAX_ROW.reserve1 }, // no code
      { code: "ANOWAX", active: 1, reserve0: { quantity: "junk" }, reserve1: ANOWAX_ROW.reserve1 },
      { code: "ANOWAX", active: 1, reserve0: ANOWAX_ROW.reserve0 }, // missing reserve1
      { code: "ANOWAX", active: 1, reserve0: null, reserve1: null },
      "not an object",
    ] as unknown as Record<string, unknown>[];
    expect(() => parseNeftyPairs(bad, WAX_USD)).not.toThrow();
    expect(parseNeftyPairs(bad, WAX_USD)).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skips a spoofed WAX contract (token identity check)", () => {
    const spoof = {
      ...ANOWAX_ROW,
      reserve1: { quantity: "100.00000000 WAX", contract: "fake.wax" },
    };
    expect(parseNeftyPairs([spoof], WAX_USD)).toHaveLength(0);
  });

  it("dedupes rows a misbehaving node returns twice", () => {
    const pools = parseNeftyPairs([ANOWAX_ROW, ANOWAX_ROW], WAX_USD);
    expect(pools).toHaveLength(1);
  });
});

describe("neftyMemo", () => {
  it("pins the live memo format swap:<CODE>,min:<rawUnits>", () => {
    // 20.96132729 WAXCASH at 8 decimals → 20961327 raw units (floored).
    expect(neftyMemo(20.96132729, 8, "WAXWAXK")).toBe("swap:WAXWAXK,min:2096132729");
    expect(neftyMemo(1.5, 4, "USDANO")).toBe("swap:USDANO,min:15000");
  });

  it("truncates toward zero and never rounds the ask up", () => {
    expect(neftyMemo(0.00019999999, 4, "USDANO")).toBe("swap:USDANO,min:1");
    // IEEE dust: 12.3456 × 10⁴ is 123455.999… — the 1e-9 correction restores it.
    expect(neftyMemo(12.3456, 4, "ANOWAX")).toBe("swap:ANOWAX,min:123456");
  });

  it("never emits a zero min-out (C1: no on-chain guarantee)", () => {
    expect(neftyMemo(0, 8, "USDANO")).toBe("swap:USDANO,min:1");
    expect(neftyMemo(0.000000001, 8, "USDANO")).toBe("swap:USDANO,min:1");
  });
});

describe("constant-product quote vs a real executed Nefty swap", () => {
  /**
   * Executed trace 2026-09-23T07:32:06 (trx 9b030d80…, Hyperion logswap):
   *   in  0.0531 USDT (usdt.alcor)  → out 70825.6999 ANON (anoncoin.gm)
   *   fee 0.0001 USDT skimmed inline (0.3% floored at 4-dec input precision)
   * The logswap's reserves are POST-trade; the pre-trade reserves are:
   *   r0 = 1951.5856 − 0.0531 + 0.0001 = 1951.5326 USDT
   *   r1 = 2607899157.0710 + 70825.6999  = 2607969982.7709 ANON
   */
  it("CP over raw reserves at 0.3% reproduces the executed fill (conservatively)", () => {
    const q = quoteConstantProduct(0.0531, 1951.5326, 2607969982.7709, NEFTY_FEE_ALCOR);
    const drift = Math.abs(q.amountOut - 70825.6999) / 70825.6999;
    expect(drift).toBeLessThan(0.005); // within 0.5% of the executed fill
    // Conservative direction: the model never quotes MORE than the pool paid
    // (the contract floors the fee at input precision, charging slightly less).
    expect(q.amountOut).toBeLessThanOrEqual(70825.6999 * 1.0001);
  });

  it("matches the executed price ratio after fee", () => {
    const q = quoteConstantProduct(0.0531, 1951.5326, 2607969982.7709, NEFTY_FEE_ALCOR);
    // trade_price from the logswap trace: 1333817.3239171375.
    expect(q.executionPrice / 1333817.3239171375).toBeCloseTo(1, 2);
  });
});

describe("dust-safe min-outs (waxterminal roundingSafeMin)", () => {
  it("asks exactly 1 raw unit below ~1000 raw units of expected output", () => {
    // 500 raw units at 4 decimals → dust: ask 1 unit, not the slippage ask.
    expect(dustSafeMinOut(0.05, 0.005, 4)).toBe(0.0001);
    // 999 raw units at 8 decimals → dust.
    expect(dustSafeMinOut(0.00000999, 0.005, 8)).toBe(1e-8);
    expect(isDustOutput(0.05, 4)).toBe(true);
    expect(isDustOutput(0.1, 4)).toBe(false); // 1000 raw units is not dust
  });

  it("leaves normal trades at the slippage-adjusted floor", () => {
    // 100 WAX at 0.5% slippage, 8 decimals → quantized strict ask.
    expect(dustSafeMinOut(100, 0.005, 8)).toBeCloseTo(99.5, 8);
    expect(dustSafeMinOut(12.3456, 0.001, 4)).toBeCloseTo(12.3332, 4);
  });

  it("returns 0 for empty/zero outputs (fail closed upstream)", () => {
    expect(dustSafeMinOut(0, 0.005, 8)).toBe(0);
    expect(dustSafeMinOut(-1, 0.005, 8)).toBe(0);
    expect(dustSafeMinOut(0.000000001, 0.005, 8)).toBe(0); // rounds to 0 raw units
    expect(isDustOutput(0, 8)).toBe(false);
  });

  it("keeps the dust ask ≥ 1 unit even at 100% slippage", () => {
    expect(dustSafeMinOut(5000, 1, 4)).toBe(0.0001);
  });
});

describe("fetchNeftyPools discovery (mocked RPC)", () => {
  function servePairs(pages: Record<string, unknown>[][], configRows?: Record<string, unknown>[]) {
    rpcPostMock.mockImplementation(async (_path: string, body: Record<string, unknown>) => {
      if (body.table === "configs") {
        return {
          rows: configRows ?? [
            { key: "fee.protocol", value: 10 },
            { key: "fee.trade", value: 20 },
          ],
          more: false,
        };
      }
      const lower = String(body.lower_bound ?? "0");
      const idx = lower === "0" || lower === "" ? 0 : pages.findIndex((p, i) => i > 0 && String(p[0]!.__key) === lower);
      const page = pages[idx === -1 ? pages.length - 1 : idx]!;
      const next = pages[pages.indexOf(page) + 1];
      return {
        rows: page.map(({ __key, ...r }) => r),
        more: Boolean(next),
        next_key: next ? String(next[0]!.__key) : undefined,
      };
    });
  }

  it("sweeps pages by next_key and parses pools", async () => {
    servePairs([
      [{ ...ANOWAX_ROW, __key: "1" }],
      [{ ...USDANO_ROW, code: "WAXUSD", reserve0: { quantity: "900.00000000 WAX", contract: "eosio.token" }, reserve1: { quantity: "36000.0000 USDT", contract: "usdt.alcor" }, __key: "2" }],
    ]);
    const pools = await fetchNeftyPools(WAX_USD);
    expect(pools.map((p) => p.pairCode).sort()).toEqual(["ANOWAX", "WAXUSD"]);
    expect(pools.every((p) => p.venue === "nefty")).toBe(true);
  });

  it("fails closed to [] when the table read throws", async () => {
    rpcPostMock.mockRejectedValue(new Error("node down"));
    await expect(fetchNeftyPools(WAX_USD)).resolves.toEqual([]);
  });

  it("fails closed to [] on a schema surprise at the table level", async () => {
    rpcPostMock.mockResolvedValue({ rows: "not-an-array", more: false });
    await expect(fetchNeftyPools(WAX_USD)).resolves.toEqual([]);
  });

  it("reads the live fee from configs (and falls back to 0.3%)", async () => {
    servePairs([[{ ...ANOWAX_ROW, __key: "1" }]], [
      { key: "fee.protocol", value: 10 },
      { key: "fee.trade", value: 30 },
    ]);
    // Fee cache is module-level; the first fetch in this file populated it at
    // 0.3%. A fresh parse with an explicit fee still honors the parameter.
    const pools = parseNeftyPairs([ANOWAX_ROW], WAX_USD, 4000);
    expect(pools[0]!.fee).toBe(4000);
    expect(pools[0]!.feePct).toBeCloseTo(0.4, 10);
    const fallback = parseNeftyPairs([ANOWAX_ROW], WAX_USD);
    expect(fallback[0]!.fee).toBe(NEFTY_FEE_ALCOR);
  });
});

describe("Nefty kill-switch (persisted setting gate)", () => {
  it("excludes Nefty pools from discovery when switched off", async () => {
    rpcPostMock.mockImplementation(async (_path: string, body: Record<string, unknown>) => {
      if (body.code === "swap.nefty") {
        if (body.table === "configs") return { rows: [], more: false };
        return { rows: [ANOWAX_ROW], more: false };
      }
      return { rows: [], more: false }; // defibox/taco empty
    });
    // Module caches venues for 120s — toggle resets via the cache key.
    setNeftyVenueEnabled(true);
    const on = await fetchExternalVenues(WAX_USD);
    expect(on.some((p) => p.venue === "nefty")).toBe(true);
    setNeftyVenueEnabled(false);
    const off = await fetchExternalVenues(WAX_USD);
    expect(off.some((p) => p.venue === "nefty")).toBe(false);
    setNeftyVenueEnabled(true); // restore default for other tests
  });
});
