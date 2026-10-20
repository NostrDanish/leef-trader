import { describe, expect, it } from "vitest";
import { PAPER_FAUCET_GRANTS, useWallet } from "./wallet";

describe("paper faucet (SIMULATED funds)", () => {
  it("credits explicit simulated grants to the paper wallet only", () => {
    const w = useWallet.getState();
    expect(w.mode).toBe("paper");
    w.resetPaper();
    useWallet.getState().paperFaucet();
    const b = useWallet.getState().paperBalances;
    expect(b.WAX).toBe(PAPER_FAUCET_GRANTS.WAX);
    expect(b.LEEF).toBe(PAPER_FAUCET_GRANTS.LEEF);
    // Live book untouched — simulated funds never mix with real balances.
    expect(useWallet.getState().liveBalances).toEqual({});
  });

  it("tops up but never shrinks an existing paper balance", () => {
    useWallet.setState({ paperBalances: { WAX: 1_000, LEEF: 10 } });
    useWallet.getState().paperFaucet();
    const b = useWallet.getState().paperBalances;
    expect(b.WAX).toBe(1_000); // above grant → kept
    expect(b.LEEF).toBe(PAPER_FAUCET_GRANTS.LEEF); // below grant → topped up
    useWallet.getState().resetPaper();
  });

  it("is a no-op in live mode", () => {
    useWallet.setState({ mode: "live", liveBalances: { WAX: 3 } });
    useWallet.getState().paperFaucet();
    expect(useWallet.getState().liveBalances).toEqual({ WAX: 3 });
    expect(useWallet.getState().paperBalances.WAX ?? 0).toBeLessThanOrEqual(
      PAPER_FAUCET_GRANTS.WAX ?? 0,
    );
    useWallet.setState({ mode: "paper", liveBalances: {} });
  });
});
