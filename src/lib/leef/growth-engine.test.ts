import { describe, expect, it } from "vitest";
import {
  buildTargetPortfolio,
  hopsForGrowth,
  normalizeTargets,
  planGrowthAction,
  snapshotTargets,
  verifyGrowthExact,
  type GrowthPlan,
} from "./growth-engine";
import type { LeefPool, LeefSnapshot } from "./types";

const WAX_USD = 0.02;

function mkPool(waxReserve: number, leefReserve: number): LeefPool {
  const pairPerLeef = waxReserve / leefReserve;
  return {
    id: 1159,
    fee: 3000,
    feePct: 0.3,
    leef: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: leefReserve },
    pair: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: waxReserve },
    leefIsA: true,
    tvlUsd: waxReserve * WAX_USD * 2,
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
    waxPerLeef: pairPerLeef,
    usdPerLeef: pairPerLeef * WAX_USD,
    tickSpacing: 60,
  };
}

function snap(pool = mkPool(50_000, 500_000_000)): LeefSnapshot {
  const leefUsd = (pool.waxPerLeef ?? 0) * WAX_USD;
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    waxUsd: WAX_USD,
    leefUsd,
    waxPerLeef: pool.waxPerLeef ?? 0,
    pools: [pool],
    aux: [],
    trades: [],
    universe: [
      {
        symbol: "WAX",
        contract: "eosio.token",
        decimals: 8,
        alcorId: "wax-eosio.token",
        poolId: 0,
        waxPerToken: 1,
        usdPrice: WAX_USD,
        tvlUsd: 1_000_000,
        stable: false,
      },
      {
        symbol: "LEEF",
        contract: "leefmaincorp",
        decimals: 4,
        alcorId: "leef-leefmaincorp",
        poolId: 1159,
        waxPerToken: pool.waxPerLeef ?? 0,
        usdPrice: leefUsd,
        tvlUsd: pool.tvlUsd,
        stable: false,
      },
    ],
  };
}

const bag = {
  "WAX@eosio.token": 500,
  WAX: 500,
};

describe("normalizeTargets", () => {
  it("defaults to LEEF and renormalizes weights", () => {
    expect(normalizeTargets([])[0]?.symbol).toBe("LEEF");
    const t = normalizeTargets([
      { symbol: "leef", weight: 2 },
      { symbol: "tlm", weight: 1 },
    ]);
    expect(t).toHaveLength(2);
    expect(t[0]!.weight + t[1]!.weight).toBeCloseTo(100, 6);
  });

  it("dedupes symbols and caps at 3", () => {
    const t = normalizeTargets([
      { symbol: "LEEF", weight: 60 },
      { symbol: "leef", weight: 10 },
      { symbol: "WAX", weight: 30 },
      { symbol: "TLM", weight: 10 },
      { symbol: "TACO", weight: 5 },
    ]);
    expect(t.map((x) => x.symbol)).toEqual(["LEEF", "WAX", "TLM"]);
    expect(t.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(100, 6);
  });
});

describe("hopsForGrowth", () => {
  it("never exceeds the user cap and is tighter on compound", () => {
    expect(hopsForGrowth("compound", 10)).toBe(2);
    expect(hopsForGrowth("balanced", 10)).toBe(3);
    expect(hopsForGrowth("max", 2)).toBe(2);
  });
});

describe("planGrowthAction", () => {
  it("HOLDs on an empty wallet and explains why", () => {
    const r = planGrowthAction(snap(), {}, {
      targets: [{ symbol: "LEEF", weight: 100 }],
      mode: "balanced",
      minUsd: 0,
      maxUsd: 1,
    });
    expect("hold" in r).toBe(true);
    if ("hold" in r) {
      expect(r.hold).toMatch(/HOLD/);
      expect(r.explain[0]).toBe("HOLD");
      expect(r.explain.some((l) => /empty/i.test(l) || /nothing to convert/i.test(l))).toBe(true);
    }
  });

  it("converts working WAX into LEEF when LEEF is the treasure", () => {
    const r = planGrowthAction(snap(), bag, {
      targets: [{ symbol: "LEEF", weight: 100 }],
      mode: "balanced",
      minUsd: 0.05,
      maxUsd: 2,
      seed: 1,
    });
    expect("hold" in r).toBe(false);
    if (!("hold" in r)) {
      expect(r.tokenIn).toBe("WAX");
      expect(r.tokenOut).toBe("LEEF");
      expect(r.kind).toBe("convert");
      expect(r.targetDelta.LEEF ?? 0).toBeGreaterThan(0);
      expect(r.explain[0]).toBe("EXECUTE");
    }
  });

  it("refuses to dump LEEF into WAX just to print a different bag", () => {
    const r = planGrowthAction(
      snap(),
      { "LEEF@leefmaincorp": 50_000_000, LEEF: 50_000_000 },
      {
        targets: [{ symbol: "LEEF", weight: 100 }],
        mode: "balanced",
        minUsd: 0.05,
        maxUsd: 2,
        seed: 1,
      },
    );
    expect("hold" in r).toBe(true);
    if ("hold" in r) {
      expect(r.hold).toMatch(/HOLD/);
      expect(r.explain.some((l) => /won't spend treasure|No route|harvest/i.test(l))).toBe(true);
    }
  });

  it("anti-destruction: thin book HOLDs instead of paying a huge impact", () => {
    const thin = snap(mkPool(2, 20_000_000));
    const r = planGrowthAction(
      thin,
      { "WAX@eosio.token": 80, WAX: 80 },
      {
        targets: [{ symbol: "LEEF", weight: 100 }],
        mode: "compound",
        minUsd: 0.2,
        maxUsd: 1.5,
        seed: 1,
      },
    );
    expect("hold" in r).toBe(true);
    if ("hold" in r) {
      expect(r.explain[0]).toBe("HOLD");
      expect(r.explain.join(" ")).toMatch(/drop|impact|execution|growth|empty|No route/i);
    }
  });

  it("snapshotTargets reports mix gap", () => {
    const rows = snapshotTargets(
      snap(),
      { "WAX@eosio.token": 100, WAX: 100, "LEEF@leefmaincorp": 0, LEEF: 0 },
      [
        { symbol: "LEEF", weight: 70 },
        { symbol: "WAX", weight: 30 },
      ],
    );
    const leef = rows.find((r) => r.symbol === "LEEF")!;
    const wax = rows.find((r) => r.symbol === "WAX")!;
    expect(leef.gapPct).toBeGreaterThan(0);
    expect(wax.gapPct).toBeLessThan(0);
  });

  it("mix is wallet-relative: a USDC stack shows up as working capital pressure", () => {
    // $1,000 USDC + $10-ish LEEF. LEEF 70 / WAX 30 target. Under the OLD
    // basket-relative math LEEF looked like 100% of the mix. Wallet-relative,
    // LEEF is ~1% of the wallet → gap ≈ +69 and USDC is deployable capital.
    const s = snap();
    const balances = {
      "WAX@eosio.token": 0,
      "LEEF@leefmaincorp": 5_000_000, // ~$10 at the fixture mark
      LEEF: 5_000_000,
      "USDC@usdc.alcor": 1000,
      USDC: 1000,
    };
    const s2 = {
      ...s,
      universe: [
        ...s.universe,
        {
          symbol: "USDC",
          contract: "usdc.alcor",
          decimals: 6,
          alcorId: "usdc-usdc.alcor",
          poolId: 0,
          waxPerToken: 50,
          usdPrice: 1,
          tvlUsd: 500_000,
          stable: true,
        },
      ],
    };
    const rows = snapshotTargets(s2, balances, [
      { symbol: "LEEF", weight: 70 },
      { symbol: "WAX", weight: 30 },
    ]);
    const leef = rows.find((r) => r.symbol === "LEEF")!;
    expect(leef.sharePct).toBeLessThan(5); // ~1% of wallet, not 100% of basket
    expect(leef.gapPct).toBeGreaterThan(60);
    const pf = buildTargetPortfolio(s2, balances, [
      { symbol: "LEEF", weight: 70 },
      { symbol: "WAX", weight: 30 },
    ]);
    expect(pf.workingCapitalUsd).toBeGreaterThan(900);
  });
});

describe("verifyGrowthExact (graph proposes, exact quote decides)", () => {
  function planFromBook(): GrowthPlan {
    const r = planGrowthAction(snap(), bag, {
      targets: [{ symbol: "LEEF", weight: 100 }],
      mode: "balanced",
      minUsd: 0.05,
      maxUsd: 2,
      seed: 1,
    });
    if ("hold" in r) throw new Error(`expected a plan, got ${r.hold}`);
    return r;
  }

  it("passes when the venue quote matches the model", () => {
    const plan = planFromBook();
    const v = verifyGrowthExact(plan, plan.amountIn, plan.route.amountOut, snap());
    expect(v.pass).toBe(true);
  });

  it("blocks when the exact quote moved against the treasure", () => {
    const plan = planFromBook();
    // 5% worse than the model — beyond the balanced acquire drop cap.
    const v = verifyGrowthExact(plan, plan.amountIn, plan.route.amountOut * 0.95, snap());
    expect(v.pass).toBe(false);
    if (!v.pass) expect(v.reason).toMatch(/drop|anti-destruction/i);
  });

  it("blocks a treasure spend the graph never should have signed", () => {
    const plan = planFromBook();
    const evil: GrowthPlan = {
      ...plan,
      tokenIn: "LEEF",
      tokenOut: "WAX",
      kind: "convert",
    };
    const v = verifyGrowthExact(evil, 1_000_000, 200, snap());
    expect(v.pass).toBe(false);
    if (!v.pass) expect(v.reason).toMatch(/won't spend treasure|growth/i);
  });
});
