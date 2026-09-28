/**
 * Non-WAX quote regression tests (BUG A): the arb/volume engine must size in
 * units of the CONFIGURED quote token, scan THAT token's pools, value P&L at
 * the quote's own USD mark, and fail closed when no mark exists — never
 * silently treat quote units as WAX or dollars.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GOALS,
  DEFAULT_RISK,
  evaluateBot,
  findArb,
  findBestArb,
  type BotInput,
} from "./bot-engine";
import type { LeefPool, LeefSnapshot } from "./types";
import type { UniverseToken } from "./universe";

const WAX_USD = 0.02;

function mkPool(
  id: number,
  pairReserve: number,
  leefReserve: number,
  pair: { symbol: string; contract: string; decimals: number } = {
    symbol: "WAX",
    contract: "eosio.token",
    decimals: 8,
  },
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

const USDT = { symbol: "USDT", contract: "usdt.alcor", decimals: 4 };

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

function mkSnap(pools: LeefPool[], withUsdtMark = true): LeefSnapshot {
  const waxPool = pools.find((p) => p.pair.symbol === "WAX");
  const waxPerLeef = waxPool?.waxPerLeef ?? 0.0001;
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
      ...(withUsdtMark ? [uniToken("USDT", "usdt.alcor", 4, 1, 50_000, true)] : []),
    ],
  };
}

function botInput(over: Partial<BotInput>): BotInput {
  return {
    now: Date.now(),
    snap: mkSnap([mkPool(1159, 50_000, 500_000_000)]),
    series: [],
    running: true,
    strategy: "volume",
    goals: { ...DEFAULT_GOALS },
    risk: { ...DEFAULT_RISK },
    position: null,
    gridAnchor: null,
    balances: { WAX: 50 },
    cooldownUntil: 0,
    tradesThisHour: 0,
    sessionRealizedUsd: 0,
    sessionStartEquityUsd: 0,
    ...over,
  };
}

describe("findArb with a configured non-WAX quote", () => {
  // Two LEEF/USDT books at slightly different prices; a WAX book sits next to
  // them and must be IGNORED when the configured quote is USDT.
  const pools = [
    mkPool(2157, 10_000, 500_000_000, USDT), // 50 000 LEEF per USDT
    mkPool(2158, 10_300, 500_000_000, USDT), // LEEF ~3% richer here
    mkPool(1159, 50_000, 500_000_000), // WAX book — not the configured quote
  ];
  const snap = mkSnap(pools);

  it("scans the configured quote's pools only and sizes in quote units", () => {
    const plan = findArb(snap, 10, 0.1, false, undefined, "USDT")!;
    expect(plan).not.toBeNull();
    expect(plan.quoteToken.symbol).toBe("USDT");
    expect(plan.quoteToken.contract).toBe("usdt.alcor");
    expect(plan.baseToken.symbol).toBe("LEEF");
    // Bought on the cheap book, sold on the rich one — in USDT units.
    expect(plan.buyPool.id).toBe(2157);
    expect(plan.sellPool.id).toBe(2158);
    expect(plan.quoteIn).toBe(10);
    expect(plan.quoteOut).toBeGreaterThan(10);
  });

  it("finds nothing on the WAX book when the quote is USDT and vice versa", () => {
    const onlyWax = mkSnap([mkPool(1159, 50_000, 500_000_000)]);
    expect(findArb(onlyWax, 10, -100, false, undefined, "USDT")).toBeNull();
    const onlyUsdt = mkSnap([mkPool(2157, 10_000, 500_000_000, USDT)]);
    expect(findArb(onlyUsdt, 10, -100, false)).toBeNull(); // default quote WAX
  });

  it("clone-symbol pools are skipped when the universe pins the contract", () => {
    const clone = { symbol: "USDT", contract: "fake.contract", decimals: 4 };
    const s = mkSnap([
      mkPool(2157, 10_000, 500_000_000, USDT),
      mkPool(2158, 10_300, 500_000_000, USDT),
      // A fake-USDT book quoting an absurd spread — must never be arbbed.
      mkPool(3000, 1, 1_000_000_000, clone),
      mkPool(3001, 10, 1_000_000_000, clone),
    ]);
    const plan = findBestArb(s, 10, -100, false, 0, undefined, "USDT")!;
    expect(plan).not.toBeNull();
    expect([plan.buyPool.id, plan.sellPool.id].every((id) => id < 3000)).toBe(true);
  });
});

describe("evaluateBot with quote=USDT (end-to-end sizing)", () => {
  const pools = [mkPool(2157, 50_000, 500_000_000, USDT)];
  const risk = {
    ...DEFAULT_RISK,
    minTradeUsd: 0.5,
    maxPositionUsd: 20,
    operationalReserveUsd: 0,
    volumeFlowGateMin: 0,
    echoBudgetUsd: 0,
  };

  it("volume maker echoes in USDT units, valued at the USDT mark", () => {
    const d = evaluateBot(
      botInput({
        strategy: "volume",
        quote: "USDT",
        balances: { USDT: 10 },
        risk,
        snap: mkSnap(pools),
      }),
    );
    expect(d.kind).toBe("arb");
    if (d.kind !== "arb") return;
    expect(d.plan.quoteToken.symbol).toBe("USDT");
    // $0.5 min trade at $1/USDT → ≥ 0.5 USDT in; bounded by the $20 cap.
    expect(d.plan.quoteIn).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(d.plan.quoteIn).toBeLessThanOrEqual(20 + 1e-9);
    // Echo is same-token round trip: out ≤ in, loss inside the budget.
    expect(d.plan.quoteOut).toBeLessThanOrEqual(d.plan.quoteIn);
    const lossPct = (d.plan.quoteOut / d.plan.quoteIn - 1) * 100;
    expect(lossPct).toBeGreaterThanOrEqual(-risk.maxEchoLossPct - 1e-9);
    // USD economics at the USDT mark — never the WAX mark (0.02).
    expect(d.opportunity?.notionalUsd).toBeCloseTo(d.plan.quoteIn * 1, 6);
  });

  it("fails closed when the quote token has no USD mark", () => {
    const d = evaluateBot(
      botInput({
        strategy: "volume",
        quote: "USDT",
        balances: { USDT: 10 },
        risk,
        snap: mkSnap(pools, false), // universe carries no USDT entry
      }),
    );
    expect(d.kind).toBe("hold");
    if (d.kind === "hold") expect(d.reason).toContain("USDT");
  });

  it("the default LEEF/WAX path is unchanged", () => {
    const d = evaluateBot(
      botInput({
        strategy: "volume",
        balances: { WAX: 50 },
        risk: { ...risk, minTradeUsd: 0.01 },
        snap: mkSnap([mkPool(1159, 50_000, 500_000_000)]),
      }),
    );
    expect(d.kind).toBe("arb");
    if (d.kind !== "arb") return;
    expect(d.plan.quoteToken.symbol).toBe("WAX");
    expect(d.opportunity?.notionalUsd).toBeCloseTo(d.plan.quoteIn * WAX_USD, 6);
  });
});
