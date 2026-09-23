import { describe, expect, it } from "vitest";
import { formatAmountParam, formatAsset } from "./tokens";
import {
  ALCOR_SWAP_CONTRACT,
  arbFloorViolation,
  assertActionPolicy,
  memoMinOutSum,
  parseSwapMemo,
  swapFloorViolation,
  type PolicyAction,
  type SwapFloor,
} from "./policy";
import { delegateBwData } from "./antelope";

const ACCOUNT = "trader.leef";

const swapMemo = (minOut: string, pools = "1159", receiver = ACCOUNT) =>
  `swapexactin#${pools}#${receiver}#${minOut}#0`;

function transfer(over: {
  contract?: string;
  from?: string;
  to?: string;
  quantity?: string;
  memo?: string;
}): PolicyAction {
  return {
    contract: over.contract ?? "eosio.token",
    name: "transfer",
    plain: {
      from: over.from ?? ACCOUNT,
      to: over.to ?? ALCOR_SWAP_CONTRACT,
      quantity: over.quantity ?? "10.00000000 WAX",
      memo: over.memo ?? swapMemo("240000.0000 LEEF@leefmaincorp"),
    },
  };
}

describe("parseSwapMemo", () => {
  it("parses a well-formed router memo", () => {
    const m = parseSwapMemo(swapMemo("240000.0000 LEEF@leefmaincorp", "1159,1213"), ACCOUNT);
    expect(m).not.toBeNull();
    expect(m!.poolIds).toEqual([1159, 1213]);
    expect(m!.receiver).toBe(ACCOUNT);
    expect(m!.minAmount).toBeCloseTo(240000, 6);
    expect(m!.minSymbol).toBe("LEEF");
    expect(m!.minContract).toBe("leefmaincorp");
  });

  it("normalizes the <receiver> placeholder against the account", () => {
    const m = parseSwapMemo(swapMemo("1.00000000 WAX@eosio.token", "1159", "<receiver>"), ACCOUNT);
    expect(m).not.toBeNull();
    expect(m!.receiver).toBe(ACCOUNT);
  });

  it("rejects memos paying a different receiver", () => {
    expect(parseSwapMemo(swapMemo("1.00000000 WAX@eosio.token", "1159", "other.account"), ACCOUNT)).toBeNull();
  });

  it("rejects malformed memos", () => {
    expect(parseSwapMemo("swapexactin#1159", ACCOUNT)).toBeNull();
    expect(parseSwapMemo("hello world", ACCOUNT)).toBeNull();
    expect(parseSwapMemo(`swapexactin#abc#${ACCOUNT}#1.0 WAX@eosio.token#0`, ACCOUNT)).toBeNull();
    expect(parseSwapMemo(`swapexactin#1159#${ACCOUNT}#-1.0 WAX@eosio.token#0`, ACCOUNT)).toBeNull();
    expect(parseSwapMemo(`swapexactin#1159#${ACCOUNT}#1.0 WAX@eosio.token`, ACCOUNT)).toBeNull();
  });
});

describe("assertActionPolicy", () => {
  it("accepts a well-formed swap transfer", () => {
    expect(() => assertActionPolicy([transfer({})], ACCOUNT)).not.toThrow();
  });

  it("rejects an empty action list", () => {
    expect(() => assertActionPolicy([], ACCOUNT)).toThrow(/nothing to execute/i);
  });

  it("rejects transfers to anywhere but the AMM", () => {
    expect(() => assertActionPolicy([transfer({ to: "some.account" })], ACCOUNT)).toThrow(
      /may only go to/,
    );
  });

  it("accepts a Defibox swap memo to swap.box", () => {
    expect(() =>
      assertActionPolicy(
        [transfer({ to: "swap.box", memo: "swap,123456,12" })],
        ACCOUNT,
      ),
    ).not.toThrow();
  });

  it("accepts a Taco min-out memo to swap.taco", () => {
    expect(() =>
      assertActionPolicy(
        [transfer({ to: "swap.taco", memo: "1.50000000 WAX@eosio.token", quantity: "10.0000 LEEF", contract: "leefmaincorp" })],
        ACCOUNT,
      ),
    ).not.toThrow();
  });

  it("rejects a malformed Defibox memo", () => {
    expect(() =>
      assertActionPolicy([transfer({ to: "swap.box", memo: "swapexactin#1#x#y#0" })], ACCOUNT),
    ).toThrow(/Defibox memo/);
  });

  it("rejects transfers from a foreign sender", () => {
    expect(() => assertActionPolicy([transfer({ from: "other.account" })], ACCOUNT)).toThrow(
      /from "other.account"/,
    );
  });

  it("rejects a spoofed LEEF contract", () => {
    expect(() =>
      assertActionPolicy(
        [transfer({ contract: "fake.leef", quantity: "1000.0000 LEEF" })],
        ACCOUNT,
      ),
    ).toThrow(/lives at leefmaincorp/);
  });

  it("rejects unknown symbols entirely", () => {
    expect(() =>
      assertActionPolicy(
        [transfer({ contract: "eosio.token", quantity: "5.00000000 SCAMTOKEN" })],
        ACCOUNT,
      ),
    ).toThrow(/unknown token/i);
  });

  it("rejects precision mismatches against the catalog", () => {
    // WAX is 8dp; a 4dp WAX quantity means catalog confusion — fail closed.
    expect(() => assertActionPolicy([transfer({ quantity: "1.0000 WAX" })], ACCOUNT)).toThrow(
      /precision/,
    );
  });

  it("rejects swap memos paying a different receiver", () => {
    expect(() =>
      assertActionPolicy(
        [transfer({ memo: swapMemo("240000.0000 LEEF@leefmaincorp", "1159", "other.account") })],
        ACCOUNT,
      ),
    ).toThrow(/memo/i);
  });

  it("rejects swap memos whose min-out token is spoofed", () => {
    expect(() =>
      assertActionPolicy(
        [transfer({ memo: swapMemo("240000.0000 LEEF@fake.leef") })],
        ACCOUNT,
      ),
    ).toThrow(/min-out/);
  });

  it("rejects a swap memo with a zero min-out — no on-chain guarantee", () => {
    expect(() =>
      assertActionPolicy(
        [transfer({ memo: swapMemo("0.00000000 WAX@eosio.token") })],
        ACCOUNT,
      ),
    ).toThrow(/zero min-out/);
  });

  it("rejects arbitrary contract actions", () => {
    expect(() =>
      assertActionPolicy(
        [{ contract: "eosio", name: "voteproducer", plain: { voter: ACCOUNT } }],
        ACCOUNT,
      ),
    ).toThrow(/not allowed/);
  });

  it("rejects non-allowlisted AMM actions", () => {
    expect(() =>
      assertActionPolicy(
        [{ contract: ALCOR_SWAP_CONTRACT, name: "withdraw", plain: { owner: ACCOUNT } }],
        ACCOUNT,
      ),
    ).toThrow(/not allowed/);
  });

  it("accepts a full add-liquidity action list", () => {
    const actions: PolicyAction[] = [
      {
        contract: "eosio.token",
        name: "transfer",
        plain: { from: ACCOUNT, to: ALCOR_SWAP_CONTRACT, quantity: "1.00000000 WAX", memo: "deposit" },
      },
      {
        contract: "leefmaincorp",
        name: "transfer",
        plain: { from: ACCOUNT, to: ALCOR_SWAP_CONTRACT, quantity: "24000.0000 LEEF", memo: "deposit" },
      },
      { contract: ALCOR_SWAP_CONTRACT, name: "addliquid", plain: { owner: ACCOUNT } },
    ];
    expect(() => assertActionPolicy(actions, ACCOUNT)).not.toThrow();
  });

  it("rejects AMM actions owned by someone else", () => {
    expect(() =>
      assertActionPolicy(
        [{ contract: ALCOR_SWAP_CONTRACT, name: "subliquid", plain: { owner: "other.account" } }],
        ACCOUNT,
      ),
    ).toThrow(/owner/);
  });

  it("rejects collect paying a foreign recipient", () => {
    expect(() =>
      assertActionPolicy(
        [
          {
            contract: ALCOR_SWAP_CONTRACT,
            name: "collect",
            plain: { owner: ACCOUNT, recipient: "other.account" },
          },
        ],
        ACCOUNT,
      ),
    ).toThrow(/pays/);
  });

  it("accepts pool tokens the caller vouches for (extraTokens)", () => {
    const tlm = { symbol: "TLM", contract: "alienworlds1", decimals: 4 };
    const leg = transfer({ contract: tlm.contract, quantity: "10.0000 TLM", memo: "deposit" });
    expect(() => assertActionPolicy([leg], ACCOUNT)).toThrow(/unknown token/i);
    expect(() => assertActionPolicy([leg], ACCOUNT, { extraTokens: [tlm] })).not.toThrow();
  });
});

describe("arbFloorViolation", () => {
  const buyLeg = (waxIn: string, minLeef = "240000.0000") => ({
    input: `${waxIn} WAX`,
    memo: swapMemo(`${minLeef} LEEF@leefmaincorp`),
  });
  const sellLeg = (leefIn: string, minWax: string) => ({
    input: `${leefIn} LEEF`,
    memo: swapMemo(`${minWax} WAX@eosio.token`),
  });

  it("passes when the enforced min-outs clear the floor", () => {
    const violation = arbFloorViolation({
      waxIn: 10,
      minProfitPct: 1.2,
      buyLegs: [buyLeg("10.00000000")],
      sellLegs: [sellLeg("240000.0000", "10.12000000")],
      account: ACCOUNT,
    });
    expect(violation).toBeNull();
  });

  it("passes for split sell legs whose min-outs sum over the floor", () => {
    const violation = arbFloorViolation({
      waxIn: 10,
      minProfitPct: 1.2,
      buyLegs: [buyLeg("6.00000000"), buyLeg("4.00000000")],
      sellLegs: [sellLeg("140000.0000", "6.07000000"), sellLeg("100000.0000", "4.06000000")],
      account: ACCOUNT,
    });
    expect(violation).toBeNull();
  });

  it("blocks when the enforced min-out dips below the floor", () => {
    // Quoted output could be 10.13 WAX, but the chain only guarantees 10.05 —
    // that is exactly the gap this invariant exists to catch.
    const violation = arbFloorViolation({
      waxIn: 10,
      minProfitPct: 1.2,
      buyLegs: [buyLeg("10.00000000")],
      sellLegs: [sellLeg("240000.0000", "10.05000000")],
      account: ACCOUNT,
    });
    expect(violation).toMatch(/profit floor/);
  });

  it("enforces negative floors (volume echo loss budget)", () => {
    const ok = arbFloorViolation({
      waxIn: 10,
      minProfitPct: -1.5,
      buyLegs: [buyLeg("10.00000000")],
      sellLegs: [sellLeg("240000.0000", "9.90000000")],
      account: ACCOUNT,
    });
    expect(ok).toBeNull();
    const bad = arbFloorViolation({
      waxIn: 10,
      minProfitPct: -1.5,
      buyLegs: [buyLeg("10.00000000")],
      sellLegs: [sellLeg("240000.0000", "9.80000000")],
      account: ACCOUNT,
    });
    expect(bad).toMatch(/profit floor/);
  });

  it("blocks sell legs whose min-out isn't WAX@eosio.token", () => {
    const violation = arbFloorViolation({
      waxIn: 10,
      minProfitPct: 1.2,
      buyLegs: [buyLeg("10.00000000")],
      sellLegs: [{ input: "240000.0000 LEEF", memo: swapMemo("10.5000 USDT@usdt.alcor") }],
      account: ACCOUNT,
    });
    expect(violation).toMatch(/isn't WAX@eosio\.token/);
  });

  it("blocks buy legs that pull more than the plan sized", () => {
    const violation = arbFloorViolation({
      waxIn: 10,
      minProfitPct: 1.2,
      buyLegs: [buyLeg("11.00000000")],
      sellLegs: [sellLeg("240000.0000", "11.50000000")],
      account: ACCOUNT,
    });
    expect(violation).toMatch(/pull/);
  });

  it("blocks missing router legs", () => {
    expect(
      arbFloorViolation({ waxIn: 10, minProfitPct: 1.2, buyLegs: [], sellLegs: [], account: ACCOUNT }),
    ).toMatch(/router legs/);
  });

  it("blocks malformed leg memos", () => {
    const violation = arbFloorViolation({
      waxIn: 10,
      minProfitPct: 1.2,
      buyLegs: [buyLeg("10.00000000")],
      sellLegs: [{ input: "240000.0000 LEEF", memo: "trust me bro" }],
      account: ACCOUNT,
    });
    expect(violation).toMatch(/failed validation/);
  });
});

describe("swapFloorViolation (non-arb Alcor swap floor)", () => {
  const WAX = { symbol: "WAX", contract: "eosio.token", decimals: 8 };
  const LEEF = { symbol: "LEEF", contract: "leefmaincorp", decimals: 4 };
  const floor = (over: Partial<SwapFloor> = {}): SwapFloor => ({
    amountIn: 10,
    expectedOut: 240_000,
    slippagePct: 0.5,
    tokenIn: WAX,
    tokenOut: LEEF,
    ...over,
  });
  const leg = (waxIn: string, minLeef = "239000.0000") => ({
    input: `${waxIn} WAX`,
    memo: swapMemo(`${minLeef} LEEF@leefmaincorp`),
  });

  it("passes a legitimate quote (min-outs clear the slippage floor)", () => {
    // 240000 × (1 − 0.5%) = 238800; the memo guarantees 239000.
    expect(
      swapFloorViolation({ floor: floor(), legs: [leg("10.00000000")], account: ACCOUNT }),
    ).toBeNull();
  });

  it("passes split legs whose min-outs sum over the floor", () => {
    expect(
      swapFloorViolation({
        floor: floor(),
        legs: [leg("6.00000000", "143400.0000"), leg("4.00000000", "95600.0000")],
        account: ACCOUNT,
      }),
    ).toBeNull();
  });

  it("rejects a min-out-0 memo", () => {
    expect(
      swapFloorViolation({
        floor: floor(),
        legs: [leg("10.00000000", "0.0000")],
        account: ACCOUNT,
      }),
    ).toMatch(/zero min-out/);
  });

  it("rejects min-outs below the slippage floor", () => {
    // 237000 < 238800 required.
    expect(
      swapFloorViolation({
        floor: floor(),
        legs: [leg("10.00000000", "237000.0000")],
        account: ACCOUNT,
      }),
    ).toMatch(/slippage floor/);
  });

  it("rejects an inflated input (router pulling more than approved)", () => {
    expect(
      swapFloorViolation({
        floor: floor(),
        legs: [leg("1000000.00000000", "999999.0000")],
        account: ACCOUNT,
      }),
    ).toMatch(/pull/);
  });

  it("rejects a leg input in the wrong token", () => {
    expect(
      swapFloorViolation({
        floor: floor(),
        legs: [{ input: "10.0000 LEEF", memo: swapMemo("239000.0000 LEEF@leefmaincorp") }],
        account: ACCOUNT,
      }),
    ).toMatch(/isn't a WAX amount/);
  });

  it("rejects a leg whose min-out token isn't the route's tokenOut", () => {
    expect(
      swapFloorViolation({
        floor: floor(),
        legs: [{ input: "10.00000000 WAX", memo: swapMemo("2390.00000000 WAX@eosio.token") }],
        account: ACCOUNT,
      }),
    ).toMatch(/isn't LEEF@leefmaincorp/);
  });

  it("rejects malformed leg memos", () => {
    expect(
      swapFloorViolation({
        floor: floor(),
        legs: [{ input: "10.00000000 WAX", memo: "trust me bro" }],
        account: ACCOUNT,
      }),
    ).toMatch(/failed validation/);
  });

  it("the firewall enforces the floor when the context vouches the economics", () => {
    const ctx = { swapFloor: floor() };
    // Legitimate: memo guarantees 239000 ≥ 238800 on a 10 WAX spend.
    expect(() =>
      assertActionPolicy(
        [transfer({ quantity: "10.00000000 WAX", memo: swapMemo("239000.0000 LEEF@leefmaincorp") })],
        ACCOUNT,
        ctx,
      ),
    ).not.toThrow();
    // Inflated input: 1,000,000 WAX transfer against a 10 WAX approval.
    expect(() =>
      assertActionPolicy(
        [transfer({ quantity: "1000000.00000000 WAX" })],
        ACCOUNT,
        ctx,
      ),
    ).toThrow(/pull/);
    // Min-out below the floor.
    expect(() =>
      assertActionPolicy(
        [transfer({ memo: swapMemo("100.0000 LEEF@leefmaincorp") })],
        ACCOUNT,
        ctx,
      ),
    ).toThrow(/slippage floor/);
  });
});

describe("memoMinOutSum", () => {
  it("sums parseable legs and treats broken ones as zero", () => {
    const legs = [
      { input: "1.0000 LEEF", memo: swapMemo("5.00000000 WAX@eosio.token") },
      { input: "1.0000 LEEF", memo: "garbage" },
      { input: "1.0000 LEEF", memo: swapMemo("2.50000000 WAX@eosio.token") },
    ];
    expect(memoMinOutSum(legs, ACCOUNT)).toBeCloseTo(7.5, 8);
  });
});

describe("delegatebw (CPU staking) policy", () => {
  const stake = (over: Record<string, unknown> = {}): PolicyAction => ({
    contract: "eosio",
    name: "delegatebw",
    plain: {
      from: ACCOUNT,
      receiver: ACCOUNT,
      stake_net_quantity: "0.00000000 WAX",
      stake_cpu_quantity: "5.00000000 WAX",
      transfer: false,
      ...over,
    },
  });

  it("allows a self-stake at 8dp WAX", () => {
    expect(() => assertActionPolicy([stake()], ACCOUNT)).not.toThrow();
  });

  it("the signer's own builder passes the firewall (field-name regression)", () => {
    // Regression: signAndPushStakeCpu once built camelCase fields
    // (stakeCpuQuantity) which the firewall reads as stake_cpu_quantity —
    // every stake failed with "bad stake_cpu_quantity". The builder now
    // emits the chain ABI names and MUST pass policy.
    expect(() =>
      assertActionPolicy(
        [{ contract: "eosio", name: "delegatebw", plain: { ...delegateBwData(ACCOUNT, 5) } }],
        ACCOUNT,
      ),
    ).not.toThrow();
  });

  it("rejects staking to another account", () => {
    expect(() => assertActionPolicy([stake({ receiver: "someone.else" })], ACCOUNT)).toThrow(
      /self|signing account/i,
    );
  });

  it("rejects transfer=true (gives the stake away)", () => {
    expect(() => assertActionPolicy([stake({ transfer: true })], ACCOUNT)).toThrow(/transfer=true/);
  });

  it("rejects non-WAX stake assets and wrong precision", () => {
    expect(() =>
      assertActionPolicy([stake({ stake_cpu_quantity: "5.0000 LEEF" })], ACCOUNT),
    ).toThrow(/WAX/);
    expect(() =>
      assertActionPolicy([stake({ stake_cpu_quantity: "5.0000 WAX" })], ACCOUNT),
    ).toThrow(/precision|8 decimals/);
  });

  it("rejects other eosio actions", () => {
    const a = stake();
    expect(() => assertActionPolicy([{ ...a, name: "refund" }], ACCOUNT)).toThrow(/not allowed/);
  });
});

describe("formatAsset / formatAmountParam", () => {
  const wax = { symbol: "WAX", contract: "eosio.token", decimals: 8, alcorId: "wax-eosio.token" };
  const leef = { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, alcorId: "leef-leefmaincorp" };

  it("never emits scientific notation", () => {
    expect(formatAmountParam(1e-8, 8)).toBe("0.00000001");
    expect(formatAsset(1e-8, wax)).toBe("0.00000001 WAX");
    expect(String(1e-8)).toMatch(/e/i);
  });

  it("truncates toward zero at token precision", () => {
    expect(formatAsset(10.123456789, wax)).toBe("10.12345678 WAX");
    expect(formatAsset(241234.56789, leef)).toBe("241234.5678 LEEF");
  });

  it("rounds a sub-precision dust amount to zero so callers can reject it", () => {
    expect(formatAmountParam(1e-12, 8)).toBe("0.00000000");
    expect(formatAsset(0, wax)).toBe("0.00000000 WAX");
  });
});

describe("Nefty venue firewall (swap.nefty)", () => {
  it("accepts a pinned Nefty swap memo with a real min-out", () => {
    // Live format verified 2026-09-23: `swap:<CODE>,min:<rawUnits>`.
    expect(() =>
      assertActionPolicy(
        [transfer({ to: "swap.nefty", memo: "swap:USDANO,min:70800", quantity: "0.0531 USDT", contract: "usdt.alcor" })],
        ACCOUNT,
        { extraTokens: [{ symbol: "USDT", contract: "usdt.alcor", decimals: 4 }] },
      ),
    ).not.toThrow();
  });

  it("rejects a Nefty memo with no min clause (WaxOnEdge-style zero floor)", () => {
    expect(() =>
      assertActionPolicy([transfer({ to: "swap.nefty", memo: "swap:USDANO" })], ACCOUNT),
    ).toThrow(/Nefty memo/);
  });

  it("rejects a zero min-out (C1: no on-chain guarantee)", () => {
    expect(() =>
      assertActionPolicy([transfer({ to: "swap.nefty", memo: "swap:USDANO,min:0" })], ACCOUNT),
    ).toThrow(/zero min-out/);
    expect(() =>
      assertActionPolicy([transfer({ to: "swap.nefty", memo: "swap:USDANO,min:000" })], ACCOUNT),
    ).toThrow(/zero min-out/);
  });

  it("rejects malformed Nefty memos (format pinned)", () => {
    for (const memo of [
      "swap:usdano,min:5", // lowercase code
      "swap:USDANO,min:1.5", // raw units are integers
      "swap:USDANO,min:5,foo", // trailing junk
      "swap:USDANO ,min:5", // whitespace inside
      "swap:,min:5",
      "swap:TOOLONGCODE8,min:5",
      "SWAP:USDANO,min:5",
    ]) {
      expect(() => assertActionPolicy([transfer({ to: "swap.nefty", memo })], ACCOUNT)).toThrow(
        /Nefty memo/,
      );
    }
  });
});

describe("swapFloorViolation — dust-safe min-outs (roundingSafeMin)", () => {
  const WAX = { symbol: "WAX", contract: "eosio.token", decimals: 8 };
  const floor = (over: Partial<SwapFloor> = {}): SwapFloor => ({
    amountIn: 0.001,
    expectedOut: 0.000005, // 500 raw units at 8 decimals → dust
    slippagePct: 0.5,
    tokenIn: WAX,
    tokenOut: WAX,
    ...over,
  });

  it("dust trades floor at exactly 1 raw unit, not the slippage ask", () => {
    // Strict ask would be 0.000005 × 0.995 = 497.5 raw units — unattainable
    // tick-rounding noise (the waxterminal revert). The floor is 1 unit.
    expect(
      swapFloorViolation({
        floor: floor(),
        legs: [{ input: "0.00100000 WAX", memo: swapMemo("0.00000001 WAX@eosio.token") }],
        account: ACCOUNT,
      }),
    ).toBeNull();
  });

  it("dust trades still reject a zero min-out (C1 semantics intact)", () => {
    expect(
      swapFloorViolation({
        floor: floor(),
        legs: [{ input: "0.00100000 WAX", memo: swapMemo("0.00000000 WAX@eosio.token") }],
        account: ACCOUNT,
      }),
    ).toMatch(/zero min-out/);
  });

  it("normal trades keep the strict slippage floor", () => {
    const normal = floor({ amountIn: 10, expectedOut: 240 });
    // 240 × 0.995 = 238.8 exactly → quantized floor 238.80000000.
    expect(
      swapFloorViolation({
        floor: normal,
        legs: [{ input: "10.00000000 WAX", memo: swapMemo("238.80000000 WAX@eosio.token") }],
        account: ACCOUNT,
      }),
    ).toBeNull();
    expect(
      swapFloorViolation({
        floor: normal,
        legs: [{ input: "10.00000000 WAX", memo: swapMemo("238.79000000 WAX@eosio.token") }],
        account: ACCOUNT,
      }),
    ).toMatch(/slippage floor/);
  });
});
