/**
 * Consolidation-pass tests (audit response): indicator family voting and
 * venue-verifiability tie-breaking.
 */
import { describe, expect, it } from "vitest";
import { decorate, scoreSignal, type Candle, type TickParams } from "./indicators";
import { preferLeefNearTies } from "./route-optimizer";
import type { SwapRoute } from "./types";

const PARAMS: TickParams = {
  smaPeriod: 5,
  emaPeriod: 5,
  bbPeriod: 5,
  bbStd: 2,
  macdFast: 3,
  macdSlow: 6,
  macdSignal: 2,
  rsiPeriod: 5,
  stochK: 5,
  stochD: 2,
  sensitivity: 1,
  engines: { bb: false, macd: false, rsi: false, ema: false, sma: false, stoch: false, vwap: false },
};

function trendCandles(up: boolean, n = 40): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = up ? 1 + i * 0.01 : 2 - i * 0.01;
    return { t: i * 30_000, o: c - 0.002, h: c + 0.004, l: c - 0.004, c, v: 1, label: "" };
  });
}

describe("indicator families — one vote per correlated family", () => {
  it("stacking the trend family does not multiply its vote", () => {
    const pts = decorate(trendCandles(true), PARAMS);
    const single = scoreSignal(pts, { ...PARAMS, engines: { ...PARAMS.engines, ema: true } });
    const stacked = scoreSignal(pts, {
      ...PARAMS,
      engines: { ...PARAMS.engines, ema: true, sma: true, macd: true },
    });
    // The family vote is the MEAN of its members: stacking correlated
    // engines can never amplify the vote past the strongest member's
    // conviction (pre-consolidation the tally counted each engine as an
    // independent voice). Bias direction is preserved.
    const strongest = Math.max(
      ...stacked.readings.filter((r) => ["ema", "sma", "macd"].includes(r.id)).map((r) => r.score),
    );
    expect(stacked.score).toBeLessThanOrEqual(strongest + 1e-9);
    expect(stacked.score).toBeGreaterThan(0);
    expect(single.bias).toBe("buy");
    expect(stacked.bias).toBe("buy");
  });

  it("a disagreeing family actually dilutes the blended vote", () => {
    const up = decorate(trendCandles(true), PARAMS);
    const trendOnly = scoreSignal(up, { ...PARAMS, engines: { ...PARAMS.engines, ema: true } });
    // RSI on a strong uptrend reads overbought → meanrev family pushes back.
    const mixed = scoreSignal(up, {
      ...PARAMS,
      engines: { ...PARAMS.engines, ema: true, rsi: true },
    });
    expect(trendOnly.score).toBeGreaterThan(0);
    expect(Math.abs(mixed.score)).toBeLessThan(Math.abs(trendOnly.score));
  });
});

/* ------------------------------------------------------------------ */

const venueRoute = (id: string, out: number, venue?: "alcor" | "defibox"): SwapRoute => ({
  id,
  kind: "direct",
  label: id,
  poolIds: [1],
  legs: [
    {
      poolId: 1,
      pairName: id,
      tokenIn: "USDT",
      tokenOut: "WAX",
      amountIn: 1,
      amountOut: out,
      feePct: 0.3,
      priceImpact: 0.01,
      venue,
    },
  ],
  amountIn: 1,
  amountOut: out,
  tokenIn: "USDT",
  tokenOut: "WAX",
  feePct: 0.3,
  priceImpact: 0.01,
  executionPrice: out,
  spotPrice: out,
  vsBestPct: 0,
  tvlUsd: 100,
  volume24Usd: 10,
  notes: [],
});

describe("venue-verifiability tie-break", () => {
  it("within a near-tie band, all-Alcor (exactly verifiable) beats fresh-model venues", () => {
    const alcor = venueRoute("alcor-direct", 99.7, "alcor");
    const defibox = venueRoute("defibox-direct", 99.75, "defibox");
    const out = preferLeefNearTies([defibox, alcor]);
    expect(out[0]!.id).toBe("alcor-direct");
  });

  it("a LEEF in-band route still outranks verifiability", () => {
    const leef = venueRoute("leef-direct", 99.6, "defibox");
    leef.legs[0]!.tokenOut = "LEEF";
    const alcor = venueRoute("alcor-direct", 99.7, "alcor");
    const out = preferLeefNearTies([alcor, leef]);
    expect(out[0]!.id).toBe("leef-direct"); // LEEF preference wins the band
    expect(out[1]!.id).toBe("alcor-direct");
  });

  it("outside the band nothing moves", () => {
    const best = venueRoute("best", 100, "defibox");
    const worseLeef = venueRoute("leef-worse", 90, "alcor");
    worseLeef.legs[0]!.tokenOut = "LEEF";
    const out = preferLeefNearTies([best, worseLeef]);
    expect(out[0]!.id).toBe("best");
  });
});
