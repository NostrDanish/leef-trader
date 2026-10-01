import { describe, expect, it } from "vitest";
import type { OnchainPool } from "@/lib/wax/alcor-onchain";
import { q64Price } from "./amm";
import {
  crossCheckQuoteAgainstPools,
  memoPoolIds,
  spotBoundOut,
  type QuoteCrossCheckInput,
} from "./onchain-check";

const ACCOUNT = "trader.leef";
const WAX = { symbol: "WAX", contract: "eosio.token", decimals: 8 };
const LEEF = { symbol: "LEEF", contract: "leefmaincorp", decimals: 4 };
const USDC = { symbol: "WAXUSDC", contract: "eth.token", decimals: 6 };

/** sqrtPriceX64 for "1 whole A = priceAInB whole B". */
function sqrtX64(priceAInB: number, decA: number, decB: number): string {
  const raw = priceAInB * 10 ** (decB - decA);
  return BigInt(Math.round(Math.sqrt(raw) * 2 ** 64)).toString();
}

function pool(
  id: number,
  a: { symbol: string; contract: string; decimals: number },
  b: { symbol: string; contract: string; decimals: number },
  priceAInB: number,
  over: Partial<OnchainPool> = {},
): OnchainPool {
  const sqrtPriceX64 = sqrtX64(priceAInB, a.decimals, b.decimals);
  return {
    id,
    active: true,
    fee: 3000,
    tickSpacing: 60,
    liquidity: "424242",
    sqrtPriceX64,
    tick: 0,
    tokenA: { ...a, quantity: 1 },
    tokenB: { ...b, quantity: 1 },
    priceAInB: q64Price(sqrtPriceX64, a.decimals, b.decimals),
    ...over,
  };
}

// LEEF/WAX like pool 217: 1 LEEF = 0.00005 WAX → 1 WAX = 20000 LEEF.
const P217 = pool(217, LEEF, WAX, 0.00005);
// Two-hop fixture: 1 WAX = 0.05 WAXUSDC, 1 WAXUSDC = 400000 LEEF.
const PWU = pool(300, WAX, USDC, 0.05);
const PUL = pool(301, USDC, LEEF, 400_000);

const memo = (pools: string, minOut: string) => `swapexactin#${pools}#${ACCOUNT}#${minOut}#0`;

function input(over: Partial<QuoteCrossCheckInput> = {}): QuoteCrossCheckInput {
  // 10 WAX at spot: 10 × 20000 × 0.997 = 199400 LEEF.
  return {
    swaps: [{ input: "10.00000000 WAX", memo: memo("217", "197000.0000 LEEF@leefmaincorp") }],
    account: ACCOUNT,
    tokenIn: WAX,
    tokenOut: LEEF,
    expectedOut: 199_000,
    guaranteedOut: 197_000,
    slippagePct: 0.5,
    maxImpactPct: 5,
    ...over,
  };
}

const pools = (...ps: OnchainPool[]) => new Map(ps.map((p) => [p.id, p]));

describe("spotBoundOut", () => {
  it("WAX→LEEF on a 0.3% pool matches price × (1 − fee)", () => {
    expect(spotBoundOut(10, [{ pool: P217, inIsA: false }])).toBeCloseTo(10 * 20_000 * 0.997, 0);
  });

  it("composes a two-hop route", () => {
    const out = spotBoundOut(10, [
      { pool: PWU, inIsA: true },
      { pool: PUL, inIsA: true },
    ]);
    expect(out).toBeCloseTo(10 * 0.05 * 0.997 * 400_000 * 0.997, -1);
  });
});

describe("crossCheckQuoteAgainstPools", () => {
  it("accepts an honest quote (output slightly under spot)", () => {
    const r = crossCheckQuoteAgainstPools(input(), pools(P217));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deviationPct).toBeLessThan(0);
  });

  it("rejects a forged-high quote (router claims more than chain spot)", () => {
    const r = crossCheckQuoteAgainstPools(input({ expectedOut: 199_400 * 1.05 }), pools(P217));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/stale or forged/);
  });

  it("rejects a forged-low floor far below spot", () => {
    const r = crossCheckQuoteAgainstPools(
      input({ expectedOut: 100_000, guaranteedOut: 99_700 }),
      pools(P217),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/forged-low/);
  });

  it("rejects a memo pool whose tokens don't match the route", () => {
    const r = crossCheckQuoteAgainstPools(
      input({ swaps: [{ input: "10.00000000 WAX", memo: memo("301", "197000.0000 LEEF@leefmaincorp") }] }),
      pools(PUL),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/does not trade WAX/);
  });

  it("rejects a spoofed token contract in the pool", () => {
    const spoof = pool(217, { ...LEEF, contract: "leefscam1111" }, WAX, 0.00005);
    const r = crossCheckQuoteAgainstPools(input(), pools(spoof));
    expect(r.ok).toBe(false);
  });

  it("fails closed when a pool is missing, inactive or empty", () => {
    expect(crossCheckQuoteAgainstPools(input(), pools()).ok).toBe(false);
    expect(crossCheckQuoteAgainstPools(input(), pools({ ...P217, active: false })).ok).toBe(false);
    expect(crossCheckQuoteAgainstPools(input(), pools({ ...P217, liquidity: "0" })).ok).toBe(false);
    expect(crossCheckQuoteAgainstPools(input(), pools({ ...P217, priceAInB: null })).ok).toBe(false);
  });

  it("checks a two-hop memo end to end", () => {
    const spot = 10 * 0.05 * 0.997 * 400_000 * 0.997;
    const ok = crossCheckQuoteAgainstPools(
      input({
        swaps: [{ input: "10.00000000 WAX", memo: memo("300,301", "195000.0000 LEEF@leefmaincorp") }],
        expectedOut: spot * 0.995,
        guaranteedOut: spot * 0.98,
      }),
      pools(PWU, PUL),
    );
    expect(ok.ok).toBe(true);
    // A route that ends in the wrong token is refused.
    const wrongEnd = crossCheckQuoteAgainstPools(
      input({ swaps: [{ input: "10.00000000 WAX", memo: memo("300", "195000.0000 LEEF@leefmaincorp") }] }),
      pools(PWU),
    );
    expect(wrongEnd.ok).toBe(false);
  });

  it("sums split legs", () => {
    const r = crossCheckQuoteAgainstPools(
      input({
        swaps: [
          { input: "5.00000000 WAX", memo: memo("217", "98500.0000 LEEF@leefmaincorp") },
          { input: "5.00000000 WAX", memo: memo("217", "98500.0000 LEEF@leefmaincorp") },
        ],
      }),
      pools(P217),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spotOut).toBeCloseTo(199_400, 0);
  });

  it("memoPoolIds collects every referenced pool once", () => {
    expect(
      memoPoolIds(
        [{ memo: memo("300,301", "1.0000 LEEF@leefmaincorp") }, { memo: memo("217,301", "1.0000 LEEF@leefmaincorp") }],
        ACCOUNT,
      ).sort(),
    ).toEqual([217, 300, 301]);
  });
});
