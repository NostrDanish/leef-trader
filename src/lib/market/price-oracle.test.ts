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
    universe,
  } as unknown as LeefSnapshot;
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
  token("USDT", "usdt.alcor", 1, {
    decimals: 6,
    stable: true,
    stableState: "PEGGED",
    priceSource: "stable-anchor+alcor",
  }),
];

describe("TokenPriceOracle", () => {
  it("resolves canonical ids and alcor ids exactly", () => {
    expect(resolveOracleToken(BASE, "WAXUSDC@eth.token")?.symbol).toBe("WAXUSDC");
    expect(resolveOracleToken(BASE, "waxusdc-eth.token")?.symbol).toBe("WAXUSDC");
    expect(resolveOracleToken(BASE, "NOPE@nope")).toBeNull();
  });

  it("values 53 WAXUSDC at approximately $53 with source/confidence", () => {
    const p = tokenPrice(snap(BASE), "WAXUSDC@eth.token");
    expect(p).not.toBeNull();
    expect(p!.priceUsd).toBeGreaterThan(0.99);
    expect(p!.priceUsd).toBeLessThan(1.02);
    expect(p!.stable).toBe(true);
    expect(p!.confidence).toBeGreaterThan(0.7);
    expect(p!.tradeAllowed).toBe(true);
  });

  it("values WAXUSDT and PARAUSD near $1 independent of WAX price", () => {
    const s = snap(BASE);
    s.waxUsd = 0.017; // WAX halves; stables must not halve with it.
    expect(tokenPrice(s, "WAXUSDT@eth.token")!.priceUsd).toBeCloseTo(1, 1);
  });

  it("a tiny divergent stable observation cannot break sizing or execution prediction", () => {
    const tiny = token("WAXUSDC", "eth.token", 0.43, {
      stable: true,
      stableState: "DEPEGGED",
      tvlUsd: 12, // way below strong-depeg evidence
      priceConfidence: 0.95,
    });
    const p = tokenPrice(snap([...BASE, tiny]), "WAXUSDC@eth.token");
    expect(p).not.toBeNull();
    expect(p!.tradeAllowed).toBe(true);
  });

  it("strong depeg evidence is visible and blocked for trading", () => {
    const depegged = token("USDT", "usdt.alcor", 0.5, {
      stable: true,
      stableState: "DEPEGGED",
      tvlUsd: 250_000,
      priceConfidence: 0.9,
    });
    const p = tokenPrice(snap([...BASE, depegged]), "USDT@usdt.alcor");
    expect(p).not.toBeNull();
    expect(p!.stableState).toBe("DEPEGGED");
    expect(p!.tradeAllowed).toBe(false);
    expect(p!.reason).toContain("blocked");
  });

  it("stale prices are rejected for trading", () => {
    const stale = token("TLM", "telosdac.io", 0.02, {
      priceTimestamp: Date.now() - 120_000,
    });
    const p = tokenPrice(snap([...BASE, stale]), "TLM@telosdac.io");
    expect(p).not.toBeNull();
    expect(p!.tradeAllowed).toBe(false);
  });

  it("never resolves an ambiguous symbol to whichever contract sorted first", () => {
    const clone = token("USDT", "fake.token", 0.02, { alcorId: "usdt-fake.token" });
    expect(resolveOracleToken([...BASE, clone], "USDT")).toBeNull();
  });
});

describe("canonical balance book", () => {
  it("keeps two same-symbol contracts separate and omits an ambiguous alias", () => {
    const book = canonicalBalanceBook([
      { symbol: "USDT", contract: "usdt.alcor", amount: 5 },
      { symbol: "USDT", contract: "fake.token", amount: 7 },
    ]);
    expect(book["USDT@usdt.alcor"]).toBe(5);
    expect(book["USDT@fake.token"]).toBe(7);
    expect(book["USDT"]).toBeUndefined();
  });

  it("renders canonical + compatibility alias as ONE holding", () => {
    const book = { "LEEF@leefmaincorp": 12, LEEF: 12 };
    const rows = walletBalanceRows(book, BASE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(12);
    expect(rows[0]!.token?.symbol).toBe("LEEF");
  });

  it("canonical identifier lookups preserve lowercase contract keys", () => {
    const book = canonicalBalanceBook([
      { symbol: "WAX", contract: "eosio.token", amount: 3 },
    ]);
    expect(balanceForIdentifier(book, BASE, "WAX@eosio.token")).toBe(3);
    expect(balanceForIdentifier(book, BASE, "wax-eosio.token")).toBe(3);
  });

  it("same-symbol contracts render separately without a duplicate alias", () => {
    const book = canonicalBalanceBook([
      { symbol: "USDT", contract: "usdt.alcor", amount: 5 },
      { symbol: "USDT", contract: "fake.token", amount: 7 },
    ]);
    const rows = walletBalanceRows(book, [...BASE, token("USDT", "fake.token", 0.02)]);
    expect(rows).toHaveLength(2);
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

describe("Portfolio Governor", () => {
  it("resizes a proposal to preserve operational reserves", () => {
    const s = portfolioState({
      balances: canonicalBalanceBook([
        { symbol: "LEEF", contract: "leefmaincorp", amount: 1000 },
      ]),
      universe: BASE,
      risk: { operationalReserveUsd: 2 },
    });
    const governed = governTrade(s, {
      tokenIn: "LEEF@leefmaincorp",
      amountIn: 900,
      tokenOut: "WAX@eosio.token",
      expectedAmountOut: 200,
    });
    // $10 wallet, $2 reserve → deployable $8 = 800 LEEF max.
    expect(governed.ok).toBe(true);
    expect(governed.amountIn).toBeCloseTo(800, 6);
  });

  it("rejects a trade that creates excessive concentration", () => {
    const s = portfolioState({
      balances: canonicalBalanceBook([
        { symbol: "LEEF", contract: "leefmaincorp", amount: 1000 },
      ]),
      universe: BASE,
      risk: { maxConcentrationPct: 50 },
    });
    const governed = governTrade(s, {
      tokenIn: "LEEF@leefmaincorp",
      amountIn: 600, // 60% of the wallet in one clip
      tokenOut: "WAX@eosio.token",
      expectedAmountOut: 25,
    });
    expect(governed.ok).toBe(false);
  });

  it("allows a profitable trade that IMPROVES an already concentrated wallet", () => {
    const s = portfolioState({
      balances: canonicalBalanceBook([
        { symbol: "LEEF", contract: "leefmaincorp", amount: 900 },
        { symbol: "WAX", contract: "eosio.token", amount: 10 },
      ]),
      universe: BASE,
      risk: { maxConcentrationPct: 50 },
    });
    const governed = governTrade(s, {
      tokenIn: "LEEF@leefmaincorp",
      amountIn: 100,
      tokenOut: "WAX@eosio.token",
      expectedAmountOut: 5,
    });
    expect(governed.ok).toBe(true);
  });

  it("allows a rebalance proposal to repair an already concentrated portfolio", () => {
    const s = portfolioState({
      balances: canonicalBalanceBook([
        { symbol: "LEEF", contract: "leefmaincorp", amount: 900 },
        { symbol: "WAX", contract: "eosio.token", amount: 10 },
      ]),
      universe: BASE,
      risk: { maxConcentrationPct: 50 },
    });
    const governed = governTrade(s, {
      tokenIn: "LEEF@leefmaincorp",
      amountIn: 500,
      tokenOut: "WAX@eosio.token",
      expectedAmountOut: 25,
    });
    expect(governed.ok).toBe(true);
  });

  it("dust wallets can trade: the reserve never zeroes a small holding", () => {
    const balances = canonicalBalanceBook([
      { symbol: "LEEF", contract: "leefmaincorp", amount: 50 }, // $0.50
    ]);
    const s = portfolioState({
      balances,
      universe: BASE,
      risk: { operationalReserveUsd: 2 },
    });
    // Uncapped reserve ($1 = 100 LEEF) would zero this; capped at 50% → 25.
    expect(deployableAmount(s, balances, "LEEF@leefmaincorp")).toBeCloseTo(25, 4);
  });

  it("still holds back the full reserve on a large holding", () => {
    const balances = canonicalBalanceBook([
      { symbol: "LEEF", contract: "leefmaincorp", amount: 10_000 }, // $100
    ]);
    const s = portfolioState({
      balances,
      universe: BASE,
      risk: { operationalReserveUsd: 2 },
    });
    expect(deployableAmount(s, balances, "LEEF@leefmaincorp")).toBeCloseTo(9800, 4);
  });

  it("caps the reserve at 50% so dust stays deployable", () => {
    const balances = canonicalBalanceBook([
      { symbol: "LEEF", contract: "leefmaincorp", amount: 100 }, // $1
    ]);
    const s = portfolioState({
      balances,
      universe: BASE,
      risk: { operationalReserveUsd: 5 },
    });
    // Uncapped reserve ($1 = 100 LEEF) would zero this; capped at 50% → 50.
    expect(deployableAmount(s, balances, "LEEF@leefmaincorp")).toBeCloseTo(50, 4);
  });
});
