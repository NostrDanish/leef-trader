import { describe, expect, it } from "vitest";
import {
  chunkSweepLegs,
  holdingsFromBalances,
  planRebalance,
  quoteOracleDeviationPct,
  DEFAULT_REBALANCE,
  DEFAULT_LADDER,
  type PlannedLeg,
} from "./rebalance";
import { mergeUniverseFromBook } from "./universe";
import { parseAssetAmount, type AlcorRouteQuote } from "@/lib/wallet/alcor-route";
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

/* ------------------------------------------------------------------ */
/* Sweep chunking + poisoned-pool guard                                 */
/* ------------------------------------------------------------------ */

function legWithQuote(fromSym: string, toSym: string, actions: number, output: string, amountIn: number, fromUsd: number, toUsd: number): PlannedLeg {
  const quote: AlcorRouteQuote = {
    route: [1],
    memo: "m",
    swaps: Array.from({ length: actions }, () => ({
      input: "1.0 T",
      memo: "m",
      output: "1.0 T",
      route: [1],
      percent: 100,
      maxSent: "1.0 T",
      minReceived: "1.0 T",
    })),
    input: `${amountIn} ${fromSym}`,
    output,
    minReceived: output,
    maxSent: `${amountIn} ${fromSym}`,
    priceImpact: "1",
  };
  return {
    from: tok(fromSym, `${fromSym.toLowerCase()}.tok`, fromUsd),
    to: tok(toSym, `${toSym.toLowerCase()}.tok`, toUsd),
    amountIn,
    estUsd: amountIn * fromUsd,
    kind: "dust",
    reason: "test",
    quote,
  };
}

describe("chunkSweepLegs", () => {
  it("packs legs up to the per-tx action cap and keeps legs atomic", () => {
    // 3 + 2 + 2 + 1 actions, cap 4 → [3] [2+2] [1]... wait: greedy order:
    // leg A(3): cur=[A] (3). leg B(2): 3+2>4 → flush [A], cur=[B] (2).
    // leg C(2): 2+2=4 ≤ 4 → cur=[B,C]. leg D(1): 4+1>4 → flush [B,C], cur=[D].
    const legs = [
      legWithQuote("A", "WAX", 3, "1 WAX", 10, 1, 1),
      legWithQuote("B", "WAX", 2, "1 WAX", 10, 1, 1),
      legWithQuote("C", "WAX", 2, "1 WAX", 10, 1, 1),
      legWithQuote("D", "WAX", 1, "1 WAX", 10, 1, 1),
    ];
    const { chunks, dropped } = chunkSweepLegs(legs, 4);
    expect(dropped).toHaveLength(0);
    expect(chunks.map((c) => c.map((l) => l.from.symbol))).toEqual([["A"], ["B", "C"], ["D"]]);
  });

  it("drops a single leg too complex for one transaction", () => {
    const legs = [legWithQuote("A", "WAX", 7, "1 WAX", 10, 1, 1), legWithQuote("B", "WAX", 1, "1 WAX", 10, 1, 1)];
    const { chunks, dropped } = chunkSweepLegs(legs, 4);
    expect(dropped.map((l) => l.from.symbol)).toEqual(["A"]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]![0]!.from.symbol).toBe("B");
  });
});

describe("quoteOracleDeviationPct (poisoned-pool guard)", () => {
  it("flags a quote paying hundreds of times the oracle value", () => {
    // 122.71M LEEF ($0.000002) ≈ $245 in; quote pays 4608 WAX ($1) out → +1780%.
    const leg = legWithQuote("LEEF", "WAX", 1, "4608.56502259 WAX", 122_710_000, 0.000002, 1);
    const dev = quoteOracleDeviationPct(leg)!;
    expect(dev).toBeGreaterThan(35);
    expect(Math.abs(dev)).toBeGreaterThan(1000);
  });

  it("passes a fair quote (~0%) and a mildly negative one", () => {
    const fair = legWithQuote("LEEF", "WAX", 1, "100 WAX", 1_000, 0.1, 1);
    expect(quoteOracleDeviationPct(fair)!).toBeCloseTo(0, 6);
    const mild = legWithQuote("LEEF", "WAX", 1, "97 WAX", 1_000, 0.1, 1);
    expect(quoteOracleDeviationPct(mild)!).toBeCloseTo(-3, 6);
  });

  it("returns null when the quote has no parseable output", () => {
    const leg = legWithQuote("LEEF", "WAX", 1, "garbage", 1000, 0.1, 1);
    expect(quoteOracleDeviationPct(leg)).toBeNull();
  });
});
