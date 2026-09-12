import { describe, expect, it } from "vitest";
import { holdingsFromBalances, planRebalance, DEFAULT_REBALANCE, DEFAULT_LADDER } from "./rebalance";
import { mergeUniverseFromBook } from "./universe";
import { parseAssetAmount } from "@/lib/wallet/alcor-route";
import type { UniverseToken } from "./universe";

function tok(
  symbol: string,
  contract: string,
  usdPrice: number,
  decimals = 4,
): UniverseToken {
  return {
    symbol,
    contract,
    decimals,
    alcorId: `${symbol.toLowerCase()}-${contract}`,
    poolId: 1,
    waxPerToken: usdPrice / 0.04,
    usdPrice,
    tvlUsd: 200,
    stable: symbol.includes("USD"),
  };
}

const UNI: UniverseToken[] = [
  tok("WAX", "eosio.token", 0.04, 8),
  tok("LEEF", "leefmaincorp", 0.000002),
  tok("WAXUSDC", "eth.token", 1, 6),
  tok("TLM", "alien.worlds", 0.002),
  tok("DUST", "niftywizards", 0.00001),
];

describe("parseAssetAmount (rebalancer paper fill)", () => {
  it("reads Alcor asset strings, not Number('12.34 LEEF')", () => {
    expect(Number("12.34 LEEF") || 0).toBe(0);
    expect(parseAssetAmount("12.34 LEEF")).toBeCloseTo(12.34, 8);
    expect(parseAssetAmount("10.00000000 WAX")).toBeCloseTo(10, 8);
  });
});

describe("holdingsFromBalances", () => {
  it("prices paper dust against the universe", () => {
    const { holdings, unknown } = holdingsFromBalances(
      { WAX: 250, LEEF: 8_000_000, TLM: 1200, DUST: 42_000, WEIRD: 9 },
      UNI,
    );
    expect(unknown).toContain("WEIRD");
    expect(holdings.find((h) => h.token.symbol === "WAX")?.usd).toBeCloseTo(10, 8);
    expect(holdings.find((h) => h.token.symbol === "TLM")?.usd).toBeCloseTo(2.4, 8);
    expect(holdings.find((h) => h.token.symbol === "DUST")?.usd).toBeCloseTo(0.42, 8);
  });

  it("does not merge same-symbol contracts", () => {
    const dupes = [tok("USDT", "a.token", 1), tok("USDT", "b.token", 0.2)];
    const { holdings } = holdingsFromBalances(
      { "USDT@a.token": 5, "USDT@b.token": 7 },
      dupes,
    );
    expect(holdings).toHaveLength(2);
    expect(holdings.find((h) => h.token.contract === "a.token")?.usd).toBeCloseTo(5, 8);
    expect(holdings.find((h) => h.token.contract === "b.token")?.usd).toBeCloseTo(1.4, 8);
  });
});

describe("planRebalance", () => {
  it("sweeps off-ladder dust into priority 1, sized to the USD leg cap", () => {
    const { holdings } = holdingsFromBalances(
      { WAX: 100, WAXUSDC: 5, TLM: 5_000 },
      UNI,
    );
    const plan = planRebalance({
      holdings,
      ladder: DEFAULT_LADDER,
      universe: UNI,
      settings: { ...DEFAULT_REBALANCE, minDustUsd: 0.5, maxLegUsdPct: 25 },
      balances: { WAX: 100, WAXUSDC: 5, TLM: 5_000 },
    });
    const dust = plan.legs.find((l) => l.kind === "dust" && l.from.symbol === "TLM");
    expect(dust).toBeDefined();
    expect(dust!.to.symbol).toBe("WAXUSDC");
    const totalUsd = holdings.reduce((s, h) => s + h.usd, 0);
    expect(dust!.estUsd).toBeLessThanOrEqual(totalUsd * 0.25 + 1e-9);
  });

  it("does not sell WAX below the CPU reserve", () => {
    const { holdings } = holdingsFromBalances({ WAX: 5, WAXUSDC: 1 }, UNI);
    const plan = planRebalance({
      holdings,
      ladder: ["waxusdc-eth.token", "wax-eosio.token"],
      universe: UNI,
      settings: { ...DEFAULT_REBALANCE, reserveWax: 5, driftPct: 1, minDustUsd: 0.01 },
      balances: { WAX: 5, WAXUSDC: 1 },
    });
    expect(plan.legs.every((l) => l.from.symbol !== "WAX")).toBe(true);
  });

  it("reports on-ladder + in-band as balanced", () => {
    const { holdings } = holdingsFromBalances({ WAXUSDC: 10, WAX: 100, LEEF: 1_000_000 }, UNI);
    const plan = planRebalance({
      holdings,
      ladder: DEFAULT_LADDER,
      universe: UNI,
      settings: { ...DEFAULT_REBALANCE, driftPct: 80 },
      balances: { WAXUSDC: 10, WAX: 100, LEEF: 1_000_000 },
    });
    expect(plan.legs.filter((l) => l.kind === "dust")).toHaveLength(0);
  });
});

describe("mergeUniverseFromBook", () => {
  it("keeps WAX and LEEF priced when the full list has not loaded", () => {
    const u = mergeUniverseFromBook([], [], [], 0.04, 0.000002);
    expect(u.find((t) => t.symbol === "WAX")?.usdPrice).toBeCloseTo(0.04, 8);
    expect(u.find((t) => t.symbol === "LEEF")?.usdPrice).toBeCloseTo(0.000002, 8);
  });
});
