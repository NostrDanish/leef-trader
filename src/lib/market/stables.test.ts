import { describe, expect, it } from "vitest";
import { usdPriceOf } from "@/lib/leef/cost-model";
import { attachUsdPrices } from "@/lib/leef/parse";
import type { AuxPool, LeefSnapshot } from "@/lib/leef/types";
import { buildUniverse, mergeUniverseFromBook } from "@/lib/leef/universe";
import {
  isTrustedStable,
  stableStateFor,
  stableUsdPrice,
  trustedStableOf,
} from "@/lib/market/stables";

const WAX_USD = 0.04;

function waxUsdcAux(opts: {
  contract?: string;
  waxQty: number;
  usdcQty: number;
  tvlUsd?: number;
}): AuxPool {
  const contract = opts.contract ?? "eth.token";
  const tvl = opts.tvlUsd ?? opts.waxQty * WAX_USD * 2;
  return {
    id: 900,
    fee: 3000,
    feePct: 0.3,
    tokenA: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: opts.waxQty },
    tokenB: { symbol: "WAXUSDC", contract, decimals: 6, quantity: opts.usdcQty },
    tvlUsd: tvl,
    volume24Usd: 0,
  };
}

describe("trusted stable registry (SYMBOL@CONTRACT, never symbol alone)", () => {
  it("accepts the real WAXUSDC issuer and rejects symbol clones", () => {
    expect(isTrustedStable("WAXUSDC", "eth.token")).toBe(true);
    expect(trustedStableOf("waxusdc", "ETH.TOKEN")).not.toBeNull();
    // Clone tokens with the same symbol on foreign contracts are NOT stables.
    expect(isTrustedStable("WAXUSDC", "evil.token")).toBe(false);
    expect(isTrustedStable("USDT", "faketokens.ai")).toBe(false);
    expect(isTrustedStable("DAI", "anything.token")).toBe(false);
  });

  it("oracle states: pegged / minor / stressed / depegged / unknown", () => {
    expect(stableStateFor(0.999, 1, 50_000)).toBe("PEGGED");
    expect(stableStateFor(1.012, 1, 50_000)).toBe("MINOR_DEVIATION");
    expect(stableStateFor(0.94, 1, 50_000)).toBe("STRESSED");
    expect(stableStateFor(0.43, 1, 50_000)).toBe("DEPEGGED");
    expect(stableStateFor(0.999, 1, 10)).toBe("UNKNOWN"); // dust pool = no observation
    expect(stableStateFor(0, 1, 50_000)).toBe("UNKNOWN");
  });

  it("a depegged trusted stable is priced HONESTLY, never forced to $1", () => {
    const p = stableUsdPrice(0.43, { liquidityUsd: 50_000 });
    expect(p.state).toBe("DEPEGGED");
    expect(p.usdPrice).toBeCloseTo(0.43, 6);
  });

  it("an unpegged clone is never given the $1 prior", () => {
    // Clone on a foreign contract: observed 0.43 stays 0.43 with stable=false
    // (handled by the universe/cost-model layers, asserted below).
    const p = stableUsdPrice(0.43, { liquidityUsd: 50_000 });
    expect(p.usdPrice).not.toBe(1);
  });
});

describe("the 53 WAXUSDC valuation bug", () => {
  it("53 WAXUSDC on the real contract values at ≈ $53", () => {
    // Deep, honest WAX/WAXUSDC pool: 2M WAX vs ~80k USDC at WAX=$0.04.
    const aux = [waxUsdcAux({ waxQty: 2_000_000, usdcQty: 80_080 })];
    const universe = mergeUniverseFromBook([], [], aux, WAX_USD, 0.000002);
    const usdc = universe.find((u) => u.symbol === "WAXUSDC" && u.contract === "eth.token")!;
    expect(usdc.stable).toBe(true);
    expect(usdc.usdPrice).toBeGreaterThan(0.98);
    expect(usdc.usdPrice).toBeLessThan(1.02);
    // 53 WAXUSDC ≈ $53, not $23.
    expect(53 * usdc.usdPrice).toBeGreaterThan(52);
    expect(53 * usdc.usdPrice).toBeLessThan(54);
  });

  it("a clone WAXUSDC pool cannot hijack the real token's price", () => {
    // Clone pool (evil contract) is DEEPER than the real one and manipulated
    // to imply $0.43 — the clone gets its own entry at 0.43 (stable=false),
    // and the trusted entry still prices ≈ $1.
    const real = waxUsdcAux({ waxQty: 2_000_000, usdcQty: 80_080, tvlUsd: 160_000 });
    const clone = waxUsdcAux({
      contract: "evil.token",
      waxQty: 4_000_000,
      usdcQty: 372_000, // 4M*0.04/372k ≈ 0.43
      tvlUsd: 1_000_000,
    });
    const universe = mergeUniverseFromBook([], [], [clone, real], WAX_USD, 0.000002);
    const trusted = universe.find((u) => u.symbol === "WAXUSDC" && u.contract === "eth.token")!;
    const fake = universe.find((u) => u.symbol === "WAXUSDC" && u.contract === "evil.token")!;
    expect(trusted.usdPrice).toBeGreaterThan(0.98);
    expect(trusted.stable).toBe(true);
    expect(fake.stable).toBe(false); // not forced to $1
    expect(fake.usdPrice).toBeCloseTo(0.43, 2); // honest clone price
    // usdPriceOf prefers the TRUSTED contract when symbols collide.
    const snap = {
      waxUsd: WAX_USD,
      leefUsd: 0.000002,
      universe,
    } as unknown as LeefSnapshot;
    expect(usdPriceOf("WAXUSDC", snap)).toBeGreaterThan(0.98);
  });

  it("two USDT contracts stay two separate assets in the universe", () => {
    const real = {
      id: 901,
      active: true,
      tvlUSD: 200_000,
      tokenA: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: 2_500_000 },
      tokenB: { symbol: "USDT", contract: "usdt.alcor", decimals: 4, quantity: 100_000 },
    };
    const fake = {
      id: 902,
      active: true,
      tvlUSD: 5_000,
      tokenA: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: 50_000 },
      tokenB: { symbol: "USDT", contract: "faketokens.ai", decimals: 4, quantity: 50_000 },
    };
    const universe = buildUniverse([real, fake], WAX_USD);
    const a = universe.find((u) => u.symbol === "USDT" && u.contract === "usdt.alcor");
    const b = universe.find((u) => u.symbol === "USDT" && u.contract === "faketokens.ai");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.stable).toBe(true);
    expect(b!.stable).toBe(false);
    // The trusted USDT is ~$1; the fake one is priced by its own (absurd) pool.
    expect(a!.usdPrice).toBeGreaterThan(0.95);
    expect(a!.usdPrice).toBeLessThan(1.05);
  });
});

describe("attachUsdPrices is contract-aware", () => {
  it("only the trusted stable contract prices LEEF directly in USD", () => {
    const mkPool = (pairContract: string): LeefSnapshot["pools"][number] =>
      ({
        id: 1,
        fee: 3000,
        feePct: 0.3,
        leef: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: 900_000_000 },
        pair: { symbol: "WAXUSDC", contract: pairContract, decimals: 6, quantity: 1_800 },
        leefIsA: true,
        tvlUsd: 0,
        volume24Usd: 0,
        volumeWeekUsd: 0,
        volumeUsdMonth: 0,
        volumeUsd90: 0,
        volumeLeef24: 0,
        volumePair24: 0,
        change24: 0,
        changeWeek: 0,
        liquidity: "0",
        pairPerLeef: 2e-6,
        leefPerPair: 500_000,
        waxPerLeef: null,
        usdPerLeef: null,
        tickSpacing: 60,
      }) as LeefSnapshot["pools"][number];

    const trusted = mkPool("eth.token");
    attachUsdPrices([trusted], [], WAX_USD, undefined);
    expect(trusted.usdPerLeef).toBeCloseTo(2e-6, 12); // LEEF priced in $ via trusted stable

    const clone = mkPool("evil.token");
    attachUsdPrices([clone], [], WAX_USD, undefined);
    expect(clone.usdPerLeef).toBeNull(); // clone ≠ stable → no USD shortcut
  });
});
