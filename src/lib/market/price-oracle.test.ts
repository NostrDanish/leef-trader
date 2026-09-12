import { describe, expect, it } from "vitest";
import type { LeefSnapshot } from "@/lib/leef/types";
import type { UniverseToken } from "@/lib/leef/universe";
import { tokenPrice, requireTradePrice, resolveOracleToken } from "./price-oracle";
import { governTrade, portfolioState } from "./portfolio-governor";
import { canonicalBalanceBook } from "@/lib/wallet/balances";

function token(
  symbol: string,
  contract: string,
  price: number,
  opts: Partial<UniverseToken> = {},
): UniverseToken {
  return {
    symbol,
    contract,
    decimals: 4,
    alcorId: `${symbol.toLowerCase()}-${contract}`,
    poolId: 1,
    waxPerToken: price / 0.04,
    usdPrice: price,
    marketPriceUsd: price,
    tvlUsd: 50_000,
    stable: false,
    priceConfidence: 0.95,
    priceTimestamp: Date.now(),
    ...opts,
  };
}

function snap(universe: UniverseToken[]): LeefSnapshot {
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    spotAt: new Date().toISOString(),
    waxUsd: 0.04,
    leefUsd: 0.01,
    waxPerLeef: 0.25,
    pools: [],
    aux: [],
    trades: [],
    universe,
  };
}

const BASE = [
  token("WAX", "eosio.token", 0.04, { decimals: 8, priceSource: "alcor-stable" }),
  token("LEEF", "leefmaincorp", 0.01, { priceSource: "alcor-leef" }),
  token("WAXUSDC", "eth.token", 1.006, {
    decimals: 6,
    stable: true,
    stableState: "MINOR_DEVIATION",
    priceSource: "stable-anchor+alcor",
  }),
  token("WAXUSDT", "eth.token", 1, {
    decimals: 6,
    stable: true,
    stableState: "PEGGED",
    priceSource: "stable-anchor+alcor",
  }),
  token("PARAUSD", "parareserves", 1, {
    decimals: 6,
    stable: true,
    stableState: "PEGGED",
    priceSource: "stable-anchor+alcor",
  }),
];

describe("TokenPriceOracle", () => {
  it("values 53 WAXUSDC at approximately $53 with source/confidence", () => {
    const p = tokenPrice(snap(BASE), "WAXUSDC@eth.token")!;
    expect(53 * p.priceUsd).toBeGreaterThan(52);
    expect(53 * p.priceUsd).toBeLessThan(54);
    expect(p.source).toBe("stable-anchor+alcor");
    expect(p.confidence).toBeGreaterThan(0.8);
  });

  it("values WAXUSDT and PARAUSD near $1 independent of WAX price", () => {
    const s = snap(BASE);
    expect(tokenPrice(s, "WAXUSDT@eth.token")!.priceUsd).toBeCloseTo(1, 4);
    expect(tokenPrice(s, "PARAUSD@parareserves")!.priceUsd).toBeCloseTo(1, 4);
    s.waxUsd = 0.01;
    expect(tokenPrice(s, "WAXUSDT@eth.token")!.priceUsd).toBeCloseTo(1, 4);
  });

  it("a tiny divergent stable observation cannot break sizing or execution prediction", () => {
    const weak = token("WAXUSDC", "eth.token", 0.43, {
      stable: true,
      stableState: "UNKNOWN",
      tvlUsd: 12,
      priceConfidence: 0.35,
    });
    const p = tokenPrice(snap([weak]), "WAXUSDC@eth.token")!;
    expect(p.marketPriceUsd).toBeCloseTo(0.43, 4);
    expect(p.priceUsd).toBe(1); // explicit stable accounting anchor
    // A verified stable anchor may size a candidate; the mandatory fresh
    // executable venue quote/min-out still decides whether funds move.
    expect(p.tradeAllowed).toBe(true);
    expect(p.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("strong depeg evidence is visible and blocked for trading", () => {
    const depeg = token("WAXUSDC", "eth.token", 0.7, {
      stable: true,
      stableState: "DEPEGGED",
      tvlUsd: 100_000,
      priceConfidence: 0.95,
    });
    const p = tokenPrice(snap([depeg]), "WAXUSDC@eth.token")!;
    expect(p.stableState).toBe("DEPEGGED");
    expect(p.deviationPct).toBeCloseTo(30, 3);
    expect(p.tradeAllowed).toBe(false);
    expect(requireTradePrice(snap([depeg]), "WAXUSDC@eth.token")).toHaveProperty("error");
  });

  it("stale prices are rejected for trading", () => {
    const stale = token("TLM", "alien.worlds", 0.002, {
      priceTimestamp: Date.now() - 120_000,
      priceConfidence: 0.95,
    });
    expect(tokenPrice(snap([stale]), "TLM@alien.worlds")!.tradeAllowed).toBe(false);
  });

  it("never resolves an ambiguous symbol to whichever contract sorted first", () => {
    const universe = [token("USDT", "a.token", 1), token("USDT", "b.token", 0.2)];
    expect(resolveOracleToken(universe, "USDT")).toBeNull();
    expect(resolveOracleToken(universe, "USDT@a.token")!.contract).toBe("a.token");
  });
});

describe("canonical balance book", () => {
  it("keeps two same-symbol contracts separate and omits an ambiguous alias", () => {
    const b = canonicalBalanceBook([
      { symbol: "USDT", contract: "a.token", amount: 5 },
      { symbol: "USDT", contract: "b.token", amount: 7 },
      { symbol: "WAX", contract: "eosio.token", amount: 10 },
    ]);
    expect(b["USDT@a.token"]).toBe(5);
    expect(b["USDT@b.token"]).toBe(7);
    expect(b.USDT).toBeUndefined();
    expect(b.WAX).toBe(10); // unique convenience alias is safe
  });
});

describe("Portfolio Governor", () => {
  it("resizes a proposal to preserve operational reserves", () => {
    const s = snap(BASE);
    const balances = canonicalBalanceBook([
      { symbol: "WAXUSDC", contract: "eth.token", amount: 2 },
      { symbol: "WAX", contract: "eosio.token", amount: 250 },
      { symbol: "LEEF", contract: "leefmaincorp", amount: 500 },
    ]);
    const d = governTrade(s, balances, {
      tokenIn: "WAXUSDC@eth.token",
      tokenOut: "LEEF@leefmaincorp",
      amountIn: 2,
      expectedOut: 200,
      expectedNetProfitUsd: 0.05,
      kind: "profit",
    });
    expect(d.allowed).toBe(true);
    expect(d.allowedAmountIn).toBeLessThan(2);
    expect(d.allowedAmountIn).toBeCloseTo(2 - 1 / 1.006, 4);
    expect(d.reason).toMatch(/reserve/);
  });

  it("rejects a trade that creates excessive concentration", () => {
    const s = snap(BASE);
    const balances = canonicalBalanceBook([
      { symbol: "WAX", contract: "eosio.token", amount: 500 }, // $20
      { symbol: "LEEF", contract: "leefmaincorp", amount: 500 }, // $5
      { symbol: "WAXUSDC", contract: "eth.token", amount: 10 }, // ~$10
    ]);
    const d = governTrade(s, balances, {
      tokenIn: "WAX@eosio.token",
      tokenOut: "LEEF@leefmaincorp",
      amountIn: 450,
      expectedOut: 4_500,
      expectedNetProfitUsd: 2,
      kind: "profit",
    });
    expect(d.allowed).toBe(false);
    expect(d.state).toBe("ASSET_CONCENTRATION");
  });

  it("allows a profitable trade that IMPROVES an already concentrated wallet", () => {
    const s = snap(BASE);
    const balances = canonicalBalanceBook([
      { symbol: "WAX", contract: "eosio.token", amount: 2_000 },
      { symbol: "LEEF", contract: "leefmaincorp", amount: 100 },
      { symbol: "WAXUSDC", contract: "eth.token", amount: 1 },
    ]);
    expect(portfolioState(s, balances).state).toBe("ASSET_CONCENTRATION");
    const d = governTrade(s, balances, {
      tokenIn: "WAX@eosio.token",
      tokenOut: "LEEF@leefmaincorp",
      amountIn: 100,
      expectedOut: 380,
      expectedNetProfitUsd: 0.1,
      kind: "profit",
    });
    expect(d.allowed).toBe(true);
    expect(d.reason).toMatch(/improves/);
  });

  it("allows a rebalance proposal to repair an already concentrated portfolio", () => {
    const s = snap(BASE);
    const balances = canonicalBalanceBook([
      { symbol: "LEEF", contract: "leefmaincorp", amount: 9_000 },
      { symbol: "WAX", contract: "eosio.token", amount: 100 },
    ]);
    expect(portfolioState(s, balances).state).toBe("ASSET_CONCENTRATION");
    const d = governTrade(s, balances, {
      tokenIn: "LEEF@leefmaincorp",
      tokenOut: "WAX@eosio.token",
      amountIn: 2_000,
      expectedOut: 500,
      expectedNetProfitUsd: -0.02,
      kind: "rebalance",
    });
    expect(d.allowed).toBe(true);
    expect(d.state).toBe("REBALANCING");
  });
});

