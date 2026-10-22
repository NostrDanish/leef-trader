import { describe, expect, it } from "vitest";
import { buildSubscribeAction, lockYearsLeft, subMemo, SAT_CONTRACT, toEpochSec } from "./contract";

const plan = { id: 1, price: { quantity: "5.0000 USDT", contract: "usdt.alcor" }, days: 30, active: 1 };

describe("sat contract client", () => {
  it("builds the sub memo", () => {
    expect(subMemo(1)).toBe("sub:1");
    expect(subMemo(2, "alice.wam")).toBe("sub:2:alice.wam");
    expect(() => subMemo(-1)).toThrow();
    expect(() => subMemo(1, "Bad Name")).toThrow();
  });
  it("builds a transfer to the contract with the plan price", () => {
    const a = buildSubscribeAction({ actor: "alice.wam", plan });
    expect(a.account).toBe("usdt.alcor");
    expect(a.data).toEqual({ from: "alice.wam", to: SAT_CONTRACT, quantity: "5.0000 USDT", memo: "sub:1" });
  });
  it("refuses inactive plans", () => {
    expect(() => buildSubscribeAction({ actor: "alice.wam", plan: { ...plan, active: 0 } })).toThrow();
  });
  it("converts lock times", () => {
    expect(toEpochSec("2068-01-01T00:00:00")).toBe(3092601600);
    expect(Math.round(lockYearsLeft(4294967295, 1792627200))).toBe(79);
  });
});
