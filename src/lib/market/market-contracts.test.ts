/**
 * UI contract libs: candles, depth, oracle (fetch shapes), plus strategy PnL.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchJsonMock, rpcPostMock } = vi.hoisted(() => ({
  fetchJsonMock: vi.fn(),
  rpcPostMock: vi.fn(),
}));
vi.mock("@/lib/fetchJson", () => ({ fetchJson: fetchJsonMock }));
vi.mock("@/lib/wallet/chain", () => ({ rpcPost: rpcPostMock }));

import { fetchLeefCandles } from "./candles";
import { fetchLeefDepth } from "./depth";
import { fetchWaxUsd } from "./oracle";
import { computeStrategyPnl } from "./pnl";

afterEach(() => {
  fetchJsonMock.mockReset();
  rpcPostMock.mockReset();
});

describe("fetchLeefCandles", () => {
  it("normalizes swap candles (LEEF/WAX) to the WAX-per-LEEF convention", async () => {
    fetchJsonMock.mockResolvedValue([
      { open: "23513.4", high: "23559.3", low: "23472.3", close: "23513.4", time: 1761001200000, volume: 4.38 },
      { open: "23500.0", high: "23513.4", low: "23400.0", close: "23513.4", time: 1760997600000, volume: 5.6 },
    ]);
    const r = await fetchLeefCandles(60, 1760990000000, 1761010000000);
    expect(r.source).toBe("alcor-swap");
    expect(r.candles).toHaveLength(2);
    expect(r.candles[0]!.time).toBe(1760997600000);
    expect(typeof r.candles[0]!.open).toBe("number");
    expect(r.candles[0]!.open).toBeCloseTo(1 / 23500, 10);
    // high/low are swapped after inversion
    expect(r.candles[0]!.high).toBeCloseTo(1 / 23400, 10);
    expect(r.candles[0]!.low).toBeCloseTo(1 / 23513.4, 10);
    expect(r.candles[0]!.high).toBeGreaterThan(r.candles[0]!.low);
  });

  it("regression: a live swap candle at 29873.8 LEEF/WAX emerges as ≈3.347e-5 WAX/LEEF", async () => {
    fetchJsonMock.mockResolvedValue([
      { open: "29800.0", high: "29950.1", low: "29750.2", close: "29873.8", time: 1761001200000, volume: 12.5 },
    ]);
    const r = await fetchLeefCandles(60, 1760990000000, 1761010000000);
    expect(r.candles).toHaveLength(1);
    const c = r.candles[0]!;
    expect(c.close).toBeCloseTo(3.3474e-5, 9);
    expect(c.open).toBeCloseTo(1 / 29800, 10);
    expect(c.high).toBeCloseTo(1 / 29750.2, 10);
    expect(c.low).toBeCloseTo(1 / 29950.1, 10);
    expect(c.volume).toBe(12.5);
  });

  it("falls back to spot charts and filters to the requested window", async () => {
    fetchJsonMock
      .mockRejectedValueOnce(new Error("swap down"))
      .mockResolvedValueOnce([
        { open: 1, high: 1, low: 1, close: 1, time: 1000, volume: 0 },
        { open: 2, high: 2, low: 2, close: 2, time: 1761000000000, volume: 0 },
      ]);
    const r = await fetchLeefCandles(15, 1760990000000, 1761010000000);
    expect(r.source).toBe("alcor-spot");
    expect(r.candles).toHaveLength(1);
    expect(r.candles[0]!.time).toBe(1761000000000);
  });

  it("returns an honest empty result when the book has no candles", async () => {
    fetchJsonMock.mockResolvedValue([]);
    const r = await fetchLeefCandles(240, 0, 1);
    expect(r.candles).toEqual([]);
  });
});

describe("fetchLeefDepth", () => {
  it("scales raw-int spot book levels by token precision", async () => {
    fetchJsonMock.mockResolvedValue({
      market_id: 119,
      bids: [[2901, [2901, 150000000, 517063082]]],
      asks: [[3800, [3800, 100000000, 380000000]]],
    });
    const r = await fetchLeefDepth();
    expect(r.source).toBe("alcor-spot");
    expect(r.unit).toBe("LEEF");
    expect(r.bids[0]!.price).toBeCloseTo(0.00002901, 8);
    expect(r.bids[0]!.quantity).toBeCloseTo(15000, 4);
    expect(r.bids[0]!.total).toBeCloseTo(0.00002901 * 15000, 8);
    expect(r.mid).toBeCloseTo((0.00002901 + 0.000038) / 2, 8);
  });

  it("AMM fallback: liquidity units, mid anchored to pool spot (not the median)", async () => {
    fetchJsonMock
      .mockRejectedValueOnce(new Error("spot down"))
      .mockResolvedValueOnce([
        { x: 18000, y: 1000000 },
        { x: 20000, y: 2000000 },
        { x: 22000, y: 1500000 },
      ])
      .mockResolvedValueOnce({
        tokenA: { symbol: "WAX", quantity: 116058.29 },
        tokenB: { symbol: "LEEF", quantity: 3000000000 },
      });
    const r = await fetchLeefDepth();
    expect(r.source).toBe("alcor-amm");
    expect(r.unit).toBe("liquidity");
    // Spot = 116058.29 / 3e9 ≈ 3.8686e-5 WAX/LEEF — the series median would
    // be 1/20000 = 5e-5, so a spot anchor is provably in use.
    expect(r.mid).toBeCloseTo(116058.29 / 3e9, 10);
    expect(r.bids.length + r.asks.length).toBe(3);
    expect(r.bids.every((l) => l.price < (r.mid ?? 0))).toBe(true);
    expect(r.asks.every((l) => l.price >= (r.mid ?? Infinity))).toBe(true);
  });

  it("AMM fallback without a pool-spot read degrades to the median anchor", async () => {
    fetchJsonMock
      .mockRejectedValueOnce(new Error("spot down"))
      .mockResolvedValueOnce([
        { x: 18000, y: 1000000 },
        { x: 20000, y: 2000000 },
        { x: 22000, y: 1500000 },
      ])
      .mockRejectedValueOnce(new Error("pool detail down"));
    const r = await fetchLeefDepth();
    expect(r.source).toBe("alcor-amm");
    expect(r.unit).toBe("liquidity");
    expect(r.mid).toBeCloseTo(1 / 20000, 10);
    expect(r.bids.length + r.asks.length).toBe(3);
  });
});

describe("fetchWaxUsd", () => {
  it("uses the median of delphioracle datapoints (value/1e4)", async () => {
    rpcPostMock.mockResolvedValue({
      rows: [{ value: 48 }, { value: 47 }, { value: 49 }, { value: 48 }, { value: 46 }],
    });
    const r = await fetchWaxUsd();
    expect(r.source).toBe("delphioracle");
    expect(r.usd).toBeCloseTo(0.0048, 6);
  });

  it("falls back to Alcor safe_usd_price when the oracle read fails", async () => {
    rpcPostMock.mockRejectedValue(new Error("rpc down"));
    fetchJsonMock.mockResolvedValue({ safe_usd_price: 0.00465312, usd_price: 0.0047 });
    const r = await fetchWaxUsd();
    expect(r.source).toBe("alcor");
    expect(r.usd).toBeCloseTo(0.00465312, 8);
  });

  it("throws when both sources are unavailable (UI shows unavailable)", async () => {
    rpcPostMock.mockRejectedValue(new Error("rpc down"));
    fetchJsonMock.mockResolvedValue({});
    await expect(fetchWaxUsd()).rejects.toThrow();
  });
});

describe("computeStrategyPnl", () => {
  it("builds per-strategy cumulative series from real journal fills", () => {
    const pts = computeStrategyPnl([
      { ts: 3000, kind: "execution", strategy: "grid", pnlUsd: 0.5, amountIn: 1 },
      { ts: 1000, kind: "execution", strategy: "grid", pnlUsd: -0.2, amountIn: 1 },
      { ts: 2000, kind: "execution", strategy: "dca", pnlUsd: 0.1, amountIn: 1 },
      { ts: 2500, kind: "gate", gate: "entry", pass: false },
      { ts: 2600, kind: "execution", strategy: "grid", selfImpactPct: 0.3 }, // observation, not a fill
    ]);
    expect(pts).toHaveLength(3);
    expect(pts[0]).toEqual({ t: 1000, strategy: "grid", realizedUsd: -0.2, cumulativeUsd: -0.2 });
    expect(pts[1]!.strategy).toBe("dca");
    expect(pts[2]).toEqual({ t: 3000, strategy: "grid", realizedUsd: 0.5, cumulativeUsd: 0.3 });
  });

  it("empty journal → honest empty series", () => {
    expect(computeStrategyPnl([])).toEqual([]);
    expect(computeStrategyPnl([{ kind: "gate" }, null, 42])).toEqual([]);
  });
});
