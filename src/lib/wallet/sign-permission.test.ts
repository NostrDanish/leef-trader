import { beforeEach, describe, expect, it, vi } from "vitest";

const signDigest = vi.fn(() => "SIG_K1_fake");
const getChainInfo = vi.fn();
const walletSession = vi.fn((): unknown => null);

vi.mock("./secret", () => ({ hasSecret: () => true, signDigest }));
vi.mock("./session", () => ({ walletSession }));
vi.mock("./chain", async (orig) => ({
  ...(await orig<typeof import("./chain")>()),
  getChainInfo,
}));

const { signAndPushStakeCpu } = await import("./sign");

describe("signer permission guard", () => {
  beforeEach(() => {
    signDigest.mockClear();
    getChainInfo.mockClear();
    walletSession.mockReset();
    walletSession.mockReturnValue(null);
  });

  it("refuses owner before any chain read or signature (session key)", async () => {
    await expect(
      signAndPushStakeCpu({ account: "trader.leef", permission: "owner", waxAmount: 1 }),
    ).rejects.toThrow(/owner/);
    expect(getChainInfo).not.toHaveBeenCalled();
    expect(signDigest).not.toHaveBeenCalled();
  });

  it("refuses an empty permission (no silent active default)", async () => {
    await expect(
      signAndPushStakeCpu({ account: "trader.leef", permission: "", waxAmount: 1 }),
    ).rejects.toThrow(/explicit permission/);
    expect(signDigest).not.toHaveBeenCalled();
  });

  it("refuses a wallet session that is logged in as owner", async () => {
    const transact = vi.fn();
    walletSession.mockReturnValue({ actor: "trader.leef", permission: "owner", transact });
    await expect(
      signAndPushStakeCpu({ account: "trader.leef", permission: "active", waxAmount: 1 }),
    ).rejects.toThrow(/owner/);
    expect(transact).not.toHaveBeenCalled();
  });
});
