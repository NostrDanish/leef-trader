import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SimulationResult } from "./simulate";

const signDigest = vi.fn(() => "SIG_K1_fake");
const pushSigned = vi.fn(async () => ({ txid: "ab".repeat(32) }));
const simulatePackedTransaction = vi.fn<() => Promise<SimulationResult>>();

vi.mock("./secret", () => ({ hasSecret: () => true, signDigest }));
vi.mock("./session", () => ({ walletSession: () => null }));
vi.mock("./simulate", () => ({ simulatePackedTransaction }));
vi.mock("./chain", async (orig) => ({
  ...(await orig<typeof import("./chain")>()),
  getChainInfo: async () => ({
    chain_id: "1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4",
    head_block_time: "2026-10-01T20:00:00.000",
    last_irreversible_block_num: 123456,
    last_irreversible_block_id: "0001e240" + "11".repeat(28),
  }),
  pushSigned,
}));

const { signAndPushStakeCpu } = await import("./sign");
const stake = () => signAndPushStakeCpu({ account: "trader.leef", permission: "active", waxAmount: 1 });

describe("pre-broadcast simulation gate (session key)", () => {
  beforeEach(() => {
    signDigest.mockClear();
    pushSigned.mockClear();
    simulatePackedTransaction.mockReset();
  });

  it("a contract assert in simulation refuses BEFORE signing or broadcasting", async () => {
    simulatePackedTransaction.mockResolvedValue({
      ok: false,
      kind: "assert",
      node: "https://wax.eosusa.io",
      reason: "overdrawn balance",
    });
    await expect(stake()).rejects.toThrow(/Simulation refused.*overdrawn/);
    expect(signDigest).not.toHaveBeenCalled();
    expect(pushSigned).not.toHaveBeenCalled();
  });

  it("a passing simulation signs and broadcasts once", async () => {
    simulatePackedTransaction.mockResolvedValue({ ok: true, node: "https://n", cpuUs: 300, elapsedUs: 400 });
    await expect(stake()).resolves.toEqual({ txid: "ab".repeat(32) });
    expect(signDigest).toHaveBeenCalledTimes(1);
    expect(pushSigned).toHaveBeenCalledTimes(1);
  });

  it("auto mode proceeds when no simulator is reachable (on-chain min-outs still apply)", async () => {
    simulatePackedTransaction.mockResolvedValue({ ok: false, kind: "unreachable", reason: "down" });
    await expect(stake()).resolves.toBeTruthy();
    expect(pushSigned).toHaveBeenCalledTimes(1);
  });
});
