import { describe, expect, it } from "vitest";
import {
  ALCOR_SWAP_CONTRACT,
  arbFloorViolation,
  assertActionPolicy,
  memoMinOutSum,
  parseSwapMemo,
  type PolicyAction,
} from "./policy";

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

  it("rejects arbitrary contract actions", () => {
    expect(() =>
      assertActionPolicy(
        [{ contract: "eosio", name: "voteproducer", plain: { voter: ACCOUNT } }],
        ACCOUNT,
      ),
    ).toThrow(/only token transfers/);
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
