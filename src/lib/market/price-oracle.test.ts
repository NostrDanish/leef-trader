import { describe, expect, it } from "vitest";
import type { LeefSnapshot } from "@/lib/leef/types";
import type { UniverseToken } from "@/lib/leef/universe";
import {
  tokenPrice,
  requireTradePrice,
  resolveOracleToken,
  stableAnchorPrice,
} from "./price-oracle";
import { deployableAmount, governTrade, portfolioState } from "./portfolio-governor";
import {
  balanceForIdentifier,
  canonicalBalanceBook,
  markPortfolioUsd,
  rowPrice,
  walletBalanceRows,
} from "@/lib/wallet/balances";

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

  it("renders canonical + compatibility alias as ONE holding", () => {
    const balances = canonicalBalanceBook([
      { symbol: "LEEF", contract: "leefmaincorp", amount: 387_770_000 },
      { symbol: "PARAUSD", contract: "parareserves", amount: 54.955 },
      { symbol: "WAX", contract: "eosio.token", amount: 3_692.3823 },
    ]);
    const rows = walletBalanceRows(balances, BASE);
    expect(rows.filter((r) => r.symbol === "LEEF")).toHaveLength(1);
    expect(rows.filter((r) => r.symbol === "PARAUSD")).toHaveLength(1);
    expect(rows.filter((r) => r.symbol === "WAX")).toHaveLength(1);
    expect(rows.find((r) => r.symbol === "LEEF")?.id).toBe("LEEF@leefmaincorp");
  });

  it("canonical identifier lookups preserve lowercase contract keys", () => {
    const balances = canonicalBalanceBook([
      { symbol: "WAXUSDC", contract: "eth.token", amount: 1.1335 },
    ]);
    expect(balanceForIdentifier(balances, BASE, "WAXUSDC@eth.token")).toBe(1.1335);
    expect(balanceForIdentifier(balances, BASE, "waxusdc@ETH.TOKEN")).toBe(1.1335);
  });

  it("same-symbol contracts render separately without a duplicate alias", () => {
    const universe = [token("USDT", "a.token", 1), token("USDT", "b.token", 0.2)];
    const balances = canonicalBalanceBook([
      { symbol: "USDT", contract: "a.token", amount: 5 },
      { symbol: "USDT", contract: "b.token", amount: 7 },
    ]);
    const rows = walletBalanceRows(balances, universe);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(["USDT@a.token", "USDT@b.token"]);
  });

  it("marks the full generic portfolio once through the same oracle", () => {
    const balances = canonicalBalanceBook([
      { symbol: "WAX", contract: "eosio.token", amount: 100 },
      { symbol: "LEEF", contract: "leefmaincorp", amount: 500 },
      { symbol: "WAXUSDC", contract: "eth.token", amount: 10 },
    ]);
    const mark = markPortfolioUsd(snap(BASE), balances);
    expect(mark.assets).toHaveLength(3);
    expect(mark.totalUsd).toBeCloseTo(4 + 5 + 10.06, 6);
    expect(mark.unpriced).toEqual([]);
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

  it("dust wallets can trade: the reserve never zeroes a small holding", () => {
    // Regression: a fixed $1 LEEF reserve meant a $0.50 LEEF bag had 0
    // deployable forever — the old trader traded ~10 LEEF clips fine.
    // LEEF-only wallet: selling some LEEF improves concentration, so the
    // governor's only possible blocker here is the reserve.
    const s = snap(BASE);
    const balances = canonicalBalanceBook([
      { symbol: "LEEF", contract: "leefmaincorp", amount: 50 }, // $0.50
    ]);
    const d = governTrade(s, balances, {
      tokenIn: "LEEF@leefmaincorp",
      tokenOut: "WAX@eosio.token",
      amountIn: 10,
      expectedOut: 2.6,
      expectedNetProfitUsd: 0.001,
      kind: "profit",
    });
    expect(d.allowed).toBe(true);
    expect(d.allowedAmountIn).toBeGreaterThan(0);
  });

  it("still holds back the full reserve on a large holding", () => {
    const s = snap(BASE);
    const balances = canonicalBalanceBook([
      { symbol: "LEEF", contract: "leefmaincorp", amount: 20_000 }, // $200
    ]);
    // Reserve $1 of LEEF = 100 LEEF held back (uncapped, well under 50%).
    expect(deployableAmount(s, balances, "LEEF@leefmaincorp")).toBeCloseTo(20_000 - 100, 4);
  });

  it("caps the reserve at 50% so dust stays deployable", () => {
    const s = snap(BASE);
    const balances = canonicalBalanceBook([
      { symbol: "LEEF", contract: "leefmaincorp", amount: 50 }, // $0.50
    ]);
    // Uncapped reserve ($1 = 100 LEEF) would zero this; capped at 50% → 25.
    expect(deployableAmount(s, balances, "LEEF@leefmaincorp")).toBeCloseTo(25, 4);
  });
});

describe("held-stable anchor valuation", () => {
  it("anchors a verified stable the snapshot universe does not know", () => {
    // Wallet holds USDT@usdt.alcor, but no USDT pool is observed right now.
    const p = stableAnchorPrice("USDT", "usdt.alcor");
    expect(p).not.toBeNull();
    expect(p!.priceUsd).toBeCloseTo(1, 6);
    expect(p!.stable).toBe(true);
    // Accounting only — without venue evidence nothing is executable.
    expect(p!.tradeAllowed).toBe(false);
    expect(p!.reason).toContain("anchor");
  });

  it("refuses to anchor an unknown or clone contract", () => {
    expect(stableAnchorPrice("USDT", "fake.token")).toBeNull();
    expect(stableAnchorPrice("RANDOM", "whatever")).toBeNull();
  });

  it("rowPrice anchors a held stable with no universe row, prices one with a row", () => {
    const held = { id: "USDT@usdt.alcor", symbol: "USDT", contract: "usdt.alcor", token: null };
    const anchored = rowPrice(snap(BASE), held);
    expect(anchored).not.toBeNull();
    expect(anchored!.anchored).toBe(true);
    expect(anchored!.tradeAllowed).toBe(false);
    expect(anchored!.priceUsd).toBeCloseTo(1, 6);

    const inUniverse = {
      id: "WAXUSDC@eth.token",
      symbol: "WAXUSDC",
      contract: "eth.token",
      token: BASE.find((t) => t.symbol === "WAXUSDC")!,
    };
    const priced = rowPrice(snap(BASE), inUniverse);
    expect(priced).not.toBeNull();
    expect(priced!.anchored).toBe(false);
    expect(priced!.tradeAllowed).toBe(true);
  });

  it("rowPrice fails closed on an unpriced unknown token", () => {
    const held = { id: "NOBODY@nobody", symbol: "NOBODY", contract: "nobody", token: null };
    expect(rowPrice(snap(BASE), held)).toBeNull();
  });

  it("markPortfolioUsd counts an anchored stable toward the total", () => {
    const balances = canonicalBalanceBook([
      { symbol: "WAX", contract: "eosio.token", amount: 100 },
      { symbol: "USDT", contract: "usdt.alcor", amount: 25 },
    ]);
    const mark = markPortfolioUsd(snap(BASE), balances);
    // WAX at the BASE mark + 25 USDT at the $1 anchor.
    expect(mark.totalUsd).toBeCloseTo(4 + 25, 6);
    expect(mark.assets.find((a) => a.id === "USDT@usdt.alcor")?.anchored).toBe(true);
    expect(mark.unpriced).toEqual([]);
  });
});
