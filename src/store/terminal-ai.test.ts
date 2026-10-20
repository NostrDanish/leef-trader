import { describe, expect, it } from "vitest";
import { useTerminal } from "./terminal";

describe("aiControl (Jev execution authority)", () => {
  it("defaults to off — zero Jev calls out of the box", () => {
    expect(useTerminal.getState().aiControl).toBe("off");
  });

  it("suggest applies without confirmation", () => {
    expect(useTerminal.getState().setAiControl("suggest")).toBe(true);
    expect(useTerminal.getState().aiControl).toBe("suggest");
    useTerminal.getState().setAiControl("off");
  });

  it("control is REFUSED without the explicit risk confirm", () => {
    expect(useTerminal.getState().setAiControl("control")).toBe(false);
    expect(useTerminal.getState().aiControl).not.toBe("control");
  });

  it("control applies only with confirmed: true, and can always be revoked", () => {
    expect(useTerminal.getState().setAiControl("control", true)).toBe(true);
    expect(useTerminal.getState().aiControl).toBe("control");
    // Re-confirming while already in control is a no-op success; leaving never needs it.
    expect(useTerminal.getState().setAiControl("control")).toBe(true);
    expect(useTerminal.getState().setAiControl("off")).toBe(true);
    expect(useTerminal.getState().aiControl).toBe("off");
  });

  it("proposal state is ephemeral and settable", () => {
    useTerminal.getState().setAiProposal(null);
    expect(useTerminal.getState().aiProposal).toBeNull();
  });

  it("a mode change clears any stale proposal; re-setting the same mode keeps it", () => {
    const proposal = { action: "buy" } as never;
    useTerminal.getState().setAiProposal(proposal);
    expect(useTerminal.getState().aiProposal).toBe(proposal);
    useTerminal.getState().setAiControl("suggest");
    expect(useTerminal.getState().aiProposal).toBeNull();
    useTerminal.getState().setAiProposal(proposal);
    useTerminal.getState().setAiControl("suggest"); // no change → untouched
    expect(useTerminal.getState().aiProposal).toBe(proposal);
    useTerminal.getState().setAiControl("off");
    expect(useTerminal.getState().aiProposal).toBeNull();
  });
});
