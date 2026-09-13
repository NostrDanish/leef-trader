import { describe, expect, it } from "vitest";
import { classifyRegime, regimeWeight, type MarketRegime } from "./regime";

function seriesFrom(prices: number[], stepMs = 30_000): { t: number; usd: number }[] {
  return prices.map((usd, i) => ({ t: i * stepMs, usd }));
}

function drift(start: number, perStepPct: number, n: number): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    out.push(p);
    p *= 1 + perStepPct / 100;
  }
  return out;
}

describe("classifyRegime", () => {
  it("is unknown while warming up", () => {
    const r = classifyRegime({ series: seriesFrom([1, 1.01, 0.99]) });
    expect(r.regime).toBe("unknown");
    expect(regimeWeight(r.regime, "dca")).toBe(1);
  });

  it("classifies a steady climb as trend_up", () => {
    const r = classifyRegime({ series: seriesFrom(drift(1, 0.35, 60)) });
    expect(r.regime).toBe("trend_up");
    expect(r.trendSepPct).toBeGreaterThan(0);
  });

  it("classifies a steady decline as trend_down and vetoes DCA", () => {
    const r = classifyRegime({ series: seriesFrom(drift(1, -0.35, 60)) });
    expect(r.regime).toBe("trend_down");
    expect(regimeWeight(r.regime, "dca")).toBe(0);
    expect(regimeWeight(r.regime, "signal")).toBeLessThan(0.5);
    expect(regimeWeight(r.regime, "spread")).toBeGreaterThanOrEqual(1);
  });

  it("classifies a quiet sideways tape as range or low_vol", () => {
    // Tiny symmetric oscillation, no drift.
    const prices = Array.from({ length: 60 }, (_, i) => 1 + (i % 2 === 0 ? 0.001 : -0.001));
    const r = classifyRegime({ series: seriesFrom(prices) });
    expect(["range", "low_vol"]).toContain(r.regime);
    expect(regimeWeight(r.regime as MarketRegime, "grid")).toBeGreaterThanOrEqual(0.9);
  });

  it("classifies violent prints as high_vol", () => {
    const prices = Array.from({ length: 60 }, (_, i) => 1 * (i % 2 === 0 ? 1.03 : 0.97));
    const r = classifyRegime({ series: seriesFrom(prices) });
    expect(r.regime).toBe("high_vol");
    expect(regimeWeight(r.regime, "spread")).toBeGreaterThan(1);
    expect(regimeWeight(r.regime, "dca")).toBeLessThanOrEqual(0.5);
  });

  it("dislocation beats trend: disagreeing pools win", () => {
    const r = classifyRegime({
      series: seriesFrom(drift(1, 0.3, 60)),
      poolPricesUsd: [1.0, 1.006],
    });
    expect(r.regime).toBe("dislocation");
    expect(regimeWeight(r.regime, "spread")).toBeGreaterThan(1.2);
    expect(regimeWeight(r.regime, "signal")).toBeLessThan(0.5);
  });

  it("single-pool book never claims dislocation", () => {
    const r = classifyRegime({
      series: seriesFrom(drift(1, 0.3, 60)),
      poolPricesUsd: [1.0],
    });
    expect(r.regime).not.toBe("dislocation");
  });
});
