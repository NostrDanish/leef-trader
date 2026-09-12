import { describe, expect, it, vi } from "vitest";
import type { UniverseToken } from "./universe";
import type { PlannedLeg } from "./rebalance";

const fetchRoute = vi.fn();
vi.mock("@/lib/leef/quote-verify", () => ({
  fetchAlcorRouteCached: (opts: unknown) => fetchRoute(opts),
}));

function tok(symbol: string): UniverseToken {
  return {
    symbol,
    contract: `${symbol.toLowerCase()}.token`,
    decimals: 4,
    alcorId: `${symbol.toLowerCase()}-${symbol.toLowerCase()}.token`,
    poolId: 1,
    waxPerToken: 1,
    usdPrice: 1,
    tvlUsd: 10_000,
    stable: false,
  };
}

function leg(i: number): PlannedLeg {
  return {
    from: tok(`IN${i}`),
    to: tok(`OUT${i}`),
    amountIn: 1,
    estUsd: 1,
    kind: "drift",
    reason: "test",
  };
}

describe("quoteLegs bounded parallelism", () => {
  it("quotes independent legs concurrently while respecting the bound", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: (() => void)[] = [];
    fetchRoute.mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          releases.push(() => {
            active -= 1;
            resolve({
              route: [1],
              memo: "x",
              swaps: [],
              input: "1.0000 IN",
              output: "1.0000 OUT",
              minReceived: "0.9900 OUT",
              maxSent: "1.0000 IN",
              priceImpact: "0.1",
            });
          });
        }),
    );
    const { quoteLegs } = await import("./rebalance");
    const pending = quoteLegs([leg(1), leg(2), leg(3), leg(4)], "paper.leef", 0.5, 4, 2);
    await Promise.resolve();
    expect(active).toBe(2);
    releases.splice(0, 2).forEach((r) => r());
    await Promise.resolve();
    await Promise.resolve();
    expect(maxActive).toBe(2);
    releases.splice(0).forEach((r) => r());
    const out = await pending;
    expect(out).toHaveLength(4);
    expect(out.every((l) => l.quote)).toBe(true);
    expect(maxActive).toBe(2);
  });
});
