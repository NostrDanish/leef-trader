import { describe, expect, it } from "vitest";
import {
  exceedsMaxPositionUsd,
  migrateRiskToUsd,
  positionMarkUsd,
  tokenAmountForUsd,
  usdToTokenBounds,
} from "./risk-usd";
import type { LeefSnapshot } from "./types";

function snap(over: Partial<LeefSnapshot> = {}): LeefSnapshot {
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    spotAt: new Date().toISOString(),
    waxUsd: 0.04,
    leefUsd: 0.000002,
    waxPerLeef: 0.00005,
    pools: [],
    aux: [],
    trades: [],
    universe: [
      {
        symbol: "WAX",
        contract: "eosio.token",
        decimals: 8,
        alcorId: "wax-eosio.token",
        poolId: 2,
        waxPerToken: 1,
        usdPrice: over.waxUsd ?? 0.04,
        tvlUsd: 50_000,
        stable: false,
        priceConfidence: 0.95,
        priceTimestamp: Date.now(),
      },
      {
        symbol: "LEEF",
        contract: "leefmaincorp",
        decimals: 4,
        alcorId: "leef-leefmaincorp",
        poolId: 3,
        waxPerToken: 0.00005,
        usdPrice: over.leefUsd ?? 0.000002,
        tvlUsd: 20_000,
        stable: false,
        priceConfidence: 0.95,
        priceTimestamp: Date.now(),
      },
      {
        symbol: "USDC",
        contract: "usdc.token",
        decimals: 6,
        alcorId: "usdc-usdc.token",
        poolId: 1,
        waxPerToken: 25,
        usdPrice: 1,
        tvlUsd: 50_000,
        stable: true,
        priceConfidence: 0.95,
        priceTimestamp: Date.now(),
      },
    ],
    ...over,
  };
}

describe("tokenAmountForUsd", () => {
  it("converts $100 at WAX=$0.04 to 2,500 WAX", () => {
    expect(tokenAmountForUsd(100, 0.04)).toBeCloseTo(2_500, 8);
  });
  it("recomputes when WAX moves to $0.05", () => {
    expect(tokenAmountForUsd(100, 0.05)).toBeCloseTo(2_000, 8);
  });
  it("returns null on zero/invalid price", () => {
    expect(tokenAmountForUsd(100, 0)).toBeNull();
    expect(tokenAmountForUsd(100, NaN)).toBeNull();
    expect(tokenAmountForUsd(100, -1)).toBeNull();
  });
});

describe("usdToTokenBounds", () => {
  it("sizes a $100 WAX position from USD limits", () => {
    const b = usdToTokenBounds({
      snap: snap({ waxUsd: 0.04 }),
      quote: "WAX",
      base: "LEEF",
      risk: { minTradeUsd: 10, maxPositionUsd: 100, operationalReserveUsd: 0 },
      position: null,
      balances: { WAX: 10_000 },
    });
    if ("error" in b) throw new Error(b.error);
    expect(b.minIn).toBeCloseTo(250, 6);
    expect(b.maxIn).toBeCloseTo(2_500, 6);
  });

  it("sizes a $100 USDC position independently of WAX", () => {
    const b = usdToTokenBounds({
      snap: snap(),
      quote: "USDC",
      base: "LEEF",
      risk: { minTradeUsd: 10, maxPositionUsd: 100, operationalReserveUsd: 0 },
      position: null,
      balances: { USDC: 500 },
    });
    if ("error" in b) throw new Error(b.error);
    expect(b.minIn).toBeCloseTo(10, 6);
    expect(b.maxIn).toBeCloseTo(100, 6);
  });

  it("caps max by wallet when wallet is below the USD ceiling", () => {
    const b = usdToTokenBounds({
      snap: snap({ waxUsd: 0.04 }),
      quote: "WAX",
      base: "LEEF",
      risk: { minTradeUsd: 0.01, maxPositionUsd: 1_000, operationalReserveUsd: 0 },
      position: null,
      balances: { WAX: 100 },
    });
    if ("error" in b) throw new Error(b.error);
    expect(b.maxIn).toBeCloseTo(100, 6);
    expect(b.remainingUsd).toBeCloseTo(1_000, 6);
  });

  it("uses current marked position — not entry WAX — for remaining capacity", () => {
    const s = snap({ leefUsd: 0.00001, waxUsd: 0.04 });
    const pos = { amountLeef: 1_000_000, entryCostUsd: 10 };
    expect(positionMarkUsd(pos, s, "LEEF")).toBeCloseTo(10, 8);
    const b = usdToTokenBounds({
      snap: s,
      quote: "WAX",
      base: "LEEF",
      risk: { minTradeUsd: 1, maxPositionUsd: 40, operationalReserveUsd: 0 },
      position: pos,
      balances: { WAX: 100_000 },
    });
    if ("error" in b) throw new Error(b.error);
    expect(b.positionUsd).toBeCloseTo(10, 6);
    expect(b.remainingUsd).toBeCloseTo(30, 6);
    expect(b.maxIn).toBeCloseTo(750, 4);
  });

  it("frees capacity after a sell (smaller position)", () => {
    const s = snap({ leefUsd: 0.00001, waxUsd: 0.04 });
    const full = usdToTokenBounds({
      snap: s,
      quote: "WAX",
      base: "LEEF",
      risk: { minTradeUsd: 1, maxPositionUsd: 40, operationalReserveUsd: 0 },
      position: { amountLeef: 4_000_000, entryCostUsd: 40 },
      balances: { WAX: 100_000 },
    });
    const half = usdToTokenBounds({
      snap: s,
      quote: "WAX",
      base: "LEEF",
      risk: { minTradeUsd: 1, maxPositionUsd: 40, operationalReserveUsd: 0 },
      position: { amountLeef: 2_000_000, entryCostUsd: 20 },
      balances: { WAX: 100_000 },
    });
    if ("error" in full || "error" in half) throw new Error("bounds");
    expect(full.maxIn).toBeCloseTo(0, 6);
    expect(half.maxIn).toBeCloseTo(500, 4);
  });

  it("fails closed on unknown USD price", () => {
    const b = usdToTokenBounds({
      snap: snap(),
      quote: "WEIRD",
      base: "LEEF",
      risk: { minTradeUsd: 1, maxPositionUsd: 10, operationalReserveUsd: 0 },
      position: null,
      balances: { WEIRD: 50 },
    });
    expect("error" in b).toBe(true);
  });

  it("fails closed on stale/zero quote mark", () => {
    const b = usdToTokenBounds({
      snap: snap({ waxUsd: 0 }),
      quote: "WAX",
      base: "LEEF",
      risk: { minTradeUsd: 1, maxPositionUsd: 10, operationalReserveUsd: 0 },
      position: null,
      balances: { WAX: 50 },
    });
    expect("error" in b).toBe(true);
  });

  it("wallet $5 / minimum $10 → effective max below min", () => {
    const b = usdToTokenBounds({
      snap: snap({ waxUsd: 0.04 }),
      quote: "WAX",
      base: "LEEF",
      risk: { minTradeUsd: 10, maxPositionUsd: 100, operationalReserveUsd: 0 },
      position: null,
      balances: { WAX: 125 }, // 125 WAX * $0.04 = $5
    });
    if ("error" in b) throw new Error(b.error);
    expect(b.walletUsd).toBeCloseTo(5, 6);
    expect(b.effectiveMaxUsd).toBeCloseTo(5, 6);
    expect(b.maxIn).toBeCloseTo(125, 6);
    expect(b.maxIn + 1e-9).toBeLessThan(b.minIn);
  });

  it("wallet $5 / minimum $1 / maximum $100 → max effective size ≤ $5", () => {
    const b = usdToTokenBounds({
      snap: snap({ waxUsd: 0.04 }),
      quote: "WAX",
      base: "LEEF",
      risk: { minTradeUsd: 1, maxPositionUsd: 100, operationalReserveUsd: 0 },
      position: null,
      balances: { WAX: 125 },
    });
    if ("error" in b) throw new Error(b.error);
    expect(b.effectiveMaxUsd).toBeCloseTo(5, 6);
    expect(b.maxIn).toBeCloseTo(125, 6);
  });

  it("operational reserve is excluded from spendable balance", () => {
    const b = usdToTokenBounds({
      snap: snap({ waxUsd: 0.04 }),
      quote: "WAX",
      base: "LEEF",
      risk: { minTradeUsd: 1, maxPositionUsd: 100, operationalReserveUsd: 2 },
      position: null,
      balances: { WAX: 250 }, // $10 wallet, $2 reserve → $8 spendable
    });
    if ("error" in b) throw new Error(b.error);
    expect(b.walletUsd).toBeCloseTo(10, 6);
    expect(b.spendableUsd).toBeCloseTo(8, 6);
    expect(b.effectiveMaxUsd).toBeCloseTo(8, 6);
  });
});

describe("exceedsMaxPositionUsd", () => {
  it("blocks a fill that would push exposure over the cap", () => {
    const s = snap({ leefUsd: 0.00001 });
    const over = exceedsMaxPositionUsd({
      snap: s,
      base: "LEEF",
      risk: { minTradeUsd: 0.01, maxPositionUsd: 10, operationalReserveUsd: 0 },
      position: { amountLeef: 900_000, entryCostUsd: 9 },
      extraBaseAmount: 200_000,
    });
    expect(over).toBe(true);
    const ok = exceedsMaxPositionUsd({
      snap: s,
      base: "LEEF",
      risk: { minTradeUsd: 0.01, maxPositionUsd: 10, operationalReserveUsd: 0 },
      position: { amountLeef: 900_000, entryCostUsd: 9 },
      extraBaseAmount: 50_000,
    });
    expect(ok).toBe(false);
  });

  it("accumulating entries share one USD ceiling", () => {
    const s = snap({ leefUsd: 0.00001 });
    const first = exceedsMaxPositionUsd({
      snap: s,
      base: "LEEF",
      risk: { minTradeUsd: 0.01, maxPositionUsd: 10, operationalReserveUsd: 0 },
      position: null,
      extraBaseAmount: 500_000,
    });
    expect(first).toBe(false);
    const second = exceedsMaxPositionUsd({
      snap: s,
      base: "LEEF",
      risk: { minTradeUsd: 0.01, maxPositionUsd: 10, operationalReserveUsd: 0 },
      position: { amountLeef: 500_000, entryCostUsd: 5 },
      extraBaseAmount: 600_000,
    });
    expect(second).toBe(true);
  });
});

describe("migrateRiskToUsd", () => {
  it("keeps already-USD fields", () => {
    const m = migrateRiskToUsd({ minTradeUsd: 2, maxPositionUsd: 80 });
    expect(m.minTradeUsd).toBe(2);
    expect(m.maxPositionUsd).toBe(80);
    expect(m.operationalReserveUsd).toBe(0);
    expect(m.notice).toBeNull();
  });
  it("preserves operationalReserveUsd", () => {
    const m = migrateRiskToUsd({ minTradeUsd: 2, maxPositionUsd: 80, operationalReserveUsd: 5 });
    expect(m.operationalReserveUsd).toBe(5);
  });

  it("does NOT treat 60 WAX as $60", () => {
    const m = migrateRiskToUsd({ clipWax: 10, maxPositionWax: 60 });
    expect(m.minTradeUsd).toBe(0);
    expect(m.maxPositionUsd).toBe(100);
    expect(m.notice).toMatch(/not converted/);
  });
});
