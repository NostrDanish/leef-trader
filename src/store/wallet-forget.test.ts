import { describe, expect, it } from "vitest";
import { useWallet } from "./wallet";

describe("useWallet.forgetSessionKey (kill-switch hygiene)", () => {
  it("drops an in-tab session key and returns to paper", () => {
    useWallet.getState().setLiveSession({
      account: "trader.leef",
      publicKey: "PUB_K1_fixture",
      permission: "active",
    });
    expect(useWallet.getState().mode).toBe("live");
    expect(useWallet.getState().forgetSessionKey()).toBe(true);
    expect(useWallet.getState().mode).toBe("paper");
    expect(useWallet.getState().authType).toBeNull();
  });

  it("leaves Cloud Wallet / Anchor sessions connected", () => {
    useWallet.getState().setWalletSession({ account: "trader.leef", permission: "active", kind: "wcw" });
    expect(useWallet.getState().forgetSessionKey()).toBe(false);
    expect(useWallet.getState().mode).toBe("live");
    expect(useWallet.getState().authType).toBe("wcw");
  });

  it("is a no-op in paper mode", () => {
    useWallet.getState().forgetLive();
    expect(useWallet.getState().forgetSessionKey()).toBe(false);
  });
});
