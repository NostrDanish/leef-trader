/**
 * wrap.alcor bridged stables (USDC@wrap.alcor, USDT@wrap.alcor — 6 decimals,
 * issuer bridge.alcor) are first-class trusted stables: registry, token
 * catalog, oracle resolution, balance lookup, and engine pair resolution all
 * treat them as $1-pegged dollar tokens WITHOUT breaking the legacy bare
 * "USDT" → usdt.alcor meaning and without letting clone contracts borrow
 * the identity.
 */
import { describe, expect, it } from "vitest";
import {
  isTrustedStable,
  trustedStableOf,
  TRUSTED_STABLES,
} from "@/lib/market/stables";
import { tokenPrice } from "@/lib/market/price-oracle";
import { metaOf, formatAsset } from "@/lib/wallet/tokens";
import { balanceForIdentifier, canonicalBalanceBook } from "@/lib/wallet/balances";
import {
  DEFAULT_GOALS,
  DEFAULT_RISK,
  evaluateBot,
  findArb,
  type BotInput,
} from "./bot-engine";
import type { LeefPool, LeefSnapshot } from "./types";
import type { UniverseToken } from "./universe";

const WAX_USD = 0.02;

function uniToken(
  symbol: string,
  contract: string,
  decimals: number,
  usdPrice: number,
  tvlUsd: number,
  stable = false,
): UniverseToken {
  return {
    symbol,
    contract,
    decimals,
    alcorId: `${symbol.toLowerCase()}-${contract}`,
    poolId: 0,
    waxPerToken: usdPrice / WAX_USD,
    usdPrice,
    tvlUsd,
    stable,
  };
}

function mkPool(
  id: number,
  pairReserve: number,
  leefReserve: number,
  pair: { symbol: string; contract: string; decimals: number },
  feePct = 0.3,
): LeefPool {
  const pairPerLeef = pairReserve / leefReserve;
  const pairUsd = pair.symbol === "WAX" ? WAX_USD : 1;
  return {
    id,
    fee: feePct * 10_000,
    feePct,
    leef: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: leefReserve },
    pair: { ...pair, quantity: pairReserve },
    leefIsA: true,
    tvlUsd: pairReserve * pairUsd * 2,
    volume24Usd: 50,
    volumeWeekUsd: 300,
    volumeUsdMonth: 1200,
    volumeUsd90: 3600,
    volumeLeef24: 0,
    volumePair24: 0,
    change24: 0,
    changeWeek: 0,
    liquidity: "0",
    pairPerLeef,
    leefPerPair: 1 / pairPerLeef,
    waxPerLeef: pair.symbol === "WAX" ? pairPerLeef : null,
    usdPerLeef: pairPerLeef * pairUsd,
    tickSpacing: 60,
  };
}

const WRAP_USDC = { symbol: "USDC", contract: "wrap.alcor", decimals: 6 };
const WRAP_USDT = { symbol: "USDT", contract: "wrap.alcor", decimals: 6 };
const LEGACY_USDT = { symbol: "USDT", contract: "usdt.alcor", decimals: 4 };

function mkSnap(pools: LeefPool[]): LeefSnapshot {
  const waxPerLeef = 0.0001;
  const leefUsd = waxPerLeef * WAX_USD;
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    waxUsd: WAX_USD,
    leefUsd,
    waxPerLeef,
    pools,
    aux: [],
    trades: [],
    universe: [
      uniToken("WAX", "eosio.token", 8, WAX_USD, 1_000_000),
      uniToken("LEEF", "leefmaincorp", 4, leefUsd, 5000),
      uniToken("USDT", "usdt.alcor", 4, 1, 50_000, true),
      uniToken("USDT", "wrap.alcor", 6, 1, 80_000, true),
      uniToken("USDC", "wrap.alcor", 6, 1, 120_000, true),
    ],
  };
}

describe("trusted-stable registry", () => {
  it("lists both wrap.alcor stables at a $1 target", () => {
    expect(isTrustedStable("USDC", "wrap.alcor")).toBe(true);
    expect(isTrustedStable("USDT", "wrap.alcor")).toBe(true);
    expect(trustedStableOf("USDC", "wrap.alcor")?.targetUsd).toBe(1);
    expect(
      TRUSTED_STABLES.find((t) => t.symbol === "USDC" && t.contract === "wrap.alcor"),
    ).toBeTruthy();
  });

  it("does not trust lookalike contracts", () => {
    expect(isTrustedStable("USDC", "fake.alcor")).toBe(false);
    expect(isTrustedStable("USDT", "wrapalcor")).toBe(false);
  });
});

describe("token catalog + metaOf", () => {
  it("knows wrap.alcor tokens at 6 decimals", () => {
    const usdc = metaOf("USDC@wrap.alcor");
    expect(usdc.decimals).toBe(6);
    expect(usdc.alcorId).toBe("usdc-wrap.alcor");
    expect(metaOf("usdt-wrap.alcor").contract).toBe("wrap.alcor");
  });

  it("bare USDT stays legacy usdt.alcor; bare USDC is wrap.alcor", () => {
    expect(metaOf("USDT").contract).toBe("usdt.alcor");
    expect(metaOf("USDC").contract).toBe("wrap.alcor");
  });

  it("formats wrap USDC at exact 6-decimal precision", () => {
    expect(formatAsset(1.23456789, metaOf("USDC@wrap.alcor"))).toBe("1.234567 USDC");
  });
});

describe("oracle + balances with dual-contract USDT", () => {
  const snap = mkSnap([]);

  it("bare USDT prices via the legacy contract; qualified ids price exactly", () => {
    expect(tokenPrice(snap, "USDT")?.contract).toBe("usdt.alcor");
    expect(tokenPrice(snap, "USDT@wrap.alcor")?.contract).toBe("wrap.alcor");
    expect(tokenPrice(snap, "USDC@wrap.alcor")?.priceUsd).toBe(1);
    expect(tokenPrice(snap, "USDC")?.priceUsd).toBe(1);
  });

  it("balances resolve per contract, never merged", () => {
    const book = canonicalBalanceBook([
      { symbol: "USDT", contract: "usdt.alcor", amount: 5 },
      { symbol: "USDT", contract: "wrap.alcor", amount: 7 },
      { symbol: "USDC", contract: "wrap.alcor", amount: 12 },
    ]);
    expect(balanceForIdentifier(book, snap.universe, "USDT@wrap.alcor")).toBe(7);
    expect(balanceForIdentifier(book, snap.universe, "USDT@usdt.alcor")).toBe(5);
    expect(balanceForIdentifier(book, snap.universe, "USDC@wrap.alcor")).toBe(12);
    // Bare symbol: deterministic legacy contract, never a merged sum.
    expect(balanceForIdentifier(book, snap.universe, "USDT")).toBe(5);
  });
});

describe("engine with a wrap.alcor quote", () => {
  const pools = [
    mkPool(4101, 10_000, 500_000_000, WRAP_USDC), // 50 000 LEEF per USDC
    mkPool(4102, 10_300, 500_000_000, WRAP_USDC), // LEEF ~3% richer
    mkPool(2157, 10_000, 500_000_000, LEGACY_USDT), // different contract — ignored
    mkPool(2158, 10_600, 500_000_000, LEGACY_USDT),
  ];
  const snap = mkSnap(pools);

  it("qualified quote id scans only that contract's pools", () => {
    const plan = findArb(snap, 10, 0.1, false, undefined, "USDC@wrap.alcor")!;
    expect(plan).not.toBeNull();
    expect(plan.quoteToken.symbol).toBe("USDC");
    expect(plan.quoteToken.contract).toBe("wrap.alcor");
    expect(plan.buyPool.id).toBe(4101);
    expect(plan.sellPool.id).toBe(4102);
    expect(plan.quoteIn).toBe(10);
    expect(plan.quoteOut).toBeGreaterThan(10);
  });

  it("bare USDT keeps legacy meaning and ignores wrap.alcor pools", () => {
    const plan = findArb(snap, 10, 0.1, false, undefined, "USDT")!;
    expect(plan.quoteToken.symbol).toBe("USDT");
    expect(plan.quoteToken.contract).toBe("usdt.alcor");
    expect([plan.buyPool.id, plan.sellPool.id].sort()).toEqual([2157, 2158]);
  });

  it("clone wrap-symbol pools are never selected", () => {
    const clone = { symbol: "USDC", contract: "fake.contract", decimals: 6 };
    const s = mkSnap([
      ...pools,
      mkPool(9001, 1, 1_000_000_000, clone),
      mkPool(9002, 10, 1_000_000_000, clone),
    ]);
    const plan = findArb(s, 10, 0.1, false, undefined, "USDC@wrap.alcor")!;
    expect([plan.buyPool.id, plan.sellPool.id].every((id) => id < 9000)).toBe(true);
  });

  it("evaluateBot sizes end-to-end in wrap USDC units at the $1 mark", () => {
    const d = evaluateBot({
      now: Date.now(),
      snap: mkSnap([mkPool(4101, 50_000, 500_000_000, WRAP_USDC)]),
      series: [],
      running: true,
      strategy: "volume",
      quote: "USDC@wrap.alcor",
      goals: { ...DEFAULT_GOALS },
      risk: {
        ...DEFAULT_RISK,
        minTradeUsd: 0.5,
        maxPositionUsd: 20,
        operationalReserveUsd: 0,
        volumeFlowGateMin: 0,
        echoBudgetUsd: 0,
      },
      position: null,
      gridAnchor: null,
      balances: { "USDC@wrap.alcor": 10 },
      cooldownUntil: 0,
      tradesThisHour: 0,
      sessionRealizedUsd: 0,
      sessionStartEquityUsd: 0,
    } satisfies BotInput);
    expect(d.kind).toBe("arb");
    if (d.kind !== "arb") return;
    expect(d.plan.quoteToken.symbol).toBe("USDC");
    expect(d.plan.quoteToken.contract).toBe("wrap.alcor");
    expect(d.plan.quoteIn).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(d.plan.quoteIn).toBeLessThanOrEqual(20 + 1e-9);
    expect(d.opportunity?.notionalUsd).toBeCloseTo(d.plan.quoteIn, 6);
  });
});
