import { describe, expect, it } from "vitest";
import { claimActionsFor, parseRewardAsset, pendingIncentiveRaw, type RewardItem } from "./rewards";
import { assertActionPolicy } from "@/lib/wallet/policy";
import { bytesToHex, nameToBigInt, packAlcorGetReward, packRewarderClaim } from "@/lib/wallet/antelope";

const ACCOUNT = "trader.leef";

describe("pendingIncentiveRaw (Alcor farm accrual)", () => {
  const inc = {
    rewardRateE18: (10n ** 18n * 100n).toString(), // 100 raw/sec across all weight
    rewardPerTokenStored: "0",
    totalStakingWeight: "1000",
    lastUpdateTime: 1_000,
    periodFinish: 2_000,
  };

  it("accrues weight-share of the rate since the last update", () => {
    // 10 s × 100 raw/s × (250 / 1000 weight) = 250 raw
    const raw = pendingIncentiveRaw(inc, { stakingWeight: "250", userRewardPerTokenPaid: "0", rewards: "0" }, 1_010);
    expect(raw).toBe(250n);
  });

  it("adds stored rewards and subtracts what was already paid per token", () => {
    const paid = ((10n ** 18n * 100n * 5n) / 1000n).toString(); // first 5 s already paid
    const raw = pendingIncentiveRaw(inc, { stakingWeight: "250", userRewardPerTokenPaid: paid, rewards: "7" }, 1_010);
    expect(raw).toBe(7n + 125n);
  });

  it("stops accruing at periodFinish", () => {
    const a = pendingIncentiveRaw(inc, { stakingWeight: "1000", userRewardPerTokenPaid: "0", rewards: "0" }, 2_000);
    const b = pendingIncentiveRaw(inc, { stakingWeight: "1000", userRewardPerTokenPaid: "0", rewards: "0" }, 9_999);
    expect(a).toBe(b);
    expect(a).toBe(100_000n);
  });

  it("never returns a negative amount", () => {
    expect(
      pendingIncentiveRaw(inc, { stakingWeight: "1", userRewardPerTokenPaid: "999999999999999999999", rewards: "0" }, 1_000),
    ).toBe(0n);
  });
});

describe("parseRewardAsset", () => {
  it("parses symbol, amount and precision", () => {
    expect(parseRewardAsset("12642.8760 LEEF")).toEqual({ amount: 12642.876, symbol: "LEEF", decimals: 4 });
    expect(parseRewardAsset("nonsense")).toBeNull();
  });
});

const items: RewardItem[] = [
  { kind: "leefrewarder", quantity: "1.0000 LEEF", amount: 1, symbol: "LEEF", contract: "leefmaincorp" },
  { kind: "alcor", incentiveId: 4242, posId: 777, poolId: 99, amount: 2, symbol: "X", contract: "x.token", decimals: 4, periodFinish: 0 },
  { kind: "alcor", incentiveId: 4242, posId: 777, poolId: 99, amount: 2, symbol: "X", contract: "x.token", decimals: 4, periodFinish: 0 },
];

describe("claimActionsFor + firewall", () => {
  it("builds one rewarder claim for the signer and de-duplicated getreward actions", () => {
    const acts = claimActionsFor(ACCOUNT, items);
    expect(acts).toEqual([
      { contract: "leefrewarder", name: "claim", data: { user: ACCOUNT } },
      { contract: "swap.alcor", name: "getreward", data: { incentiveId: 4242, posId: 777 } },
    ]);
    expect(() =>
      assertActionPolicy(
        acts.map((a) => ({ contract: a.contract, name: a.name, plain: { ...a.data } })),
        ACCOUNT,
      ),
    ).not.toThrow();
  });

  it("refuses a rewarder claim for someone else, extra fields, or other rewarder actions", () => {
    const claim = (plain: Record<string, unknown>, name = "claim") => () =>
      assertActionPolicy([{ contract: "leefrewarder", name, plain }], ACCOUNT);
    expect(claim({ user: "other.acct" })).toThrow(/signing account/);
    expect(claim({ user: ACCOUNT, to: "evil" })).toThrow(/exactly/);
    expect(claim({}, "calcrewards")).toThrow(/not allowed/);
    expect(claim({}, "init")).toThrow(/not allowed/);
  });

  it("refuses malformed getreward and other farm actions on swap.alcor", () => {
    const act = (name: string, plain: Record<string, unknown>) => () =>
      assertActionPolicy([{ contract: "swap.alcor", name, plain }], ACCOUNT);
    expect(act("getreward", { incentiveId: -1, posId: 1 })).toThrow(/non-negative/);
    expect(act("getreward", { incentiveId: "1", posId: 1 })).toThrow(/non-negative/);
    expect(act("getreward", { incentiveId: 1, posId: 1, extra: 1 })).toThrow(/exactly/);
    for (const n of ["stake", "unstake", "unstakepos", "lockpos", "transferpos", "withdraw"]) {
      expect(act(n, {})).toThrow(/not allowed/);
    }
  });
});

describe("claim action packers", () => {
  it("packRewarderClaim is the 8-byte name", () => {
    const bytes = packRewarderClaim(ACCOUNT);
    expect(bytes.length).toBe(8);
    let n = 0n;
    for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
    expect(n).toBe(nameToBigInt(ACCOUNT));
  });

  it("packAlcorGetReward is two little-endian uint64s", () => {
    expect(bytesToHex(packAlcorGetReward({ incentiveId: 1, posId: 258 }))).toBe(
      "0100000000000000" + "0201000000000000",
    );
  });
});
