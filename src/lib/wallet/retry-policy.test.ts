import { describe, expect, it } from "vitest";
import { TradeError } from "./trade-error";
import { failurePolicy, withTransientPreparationRetry } from "./retry-policy";

// Policy tests stay pure: transaction submission is intentionally never
// wrapped by retry-policy.ts.
describe("execution failure retry policy", () => {
  it("requotes one time for stale data", () => {
    const p = failurePolicy(new TradeError("QUOTE_STALE", "old"));
    expect(p.class).toBe("STALE_DATA");
    expect(p.retry).toBe("requote");
    expect(p.maxRetries).toBe(1);
  });

  it("reroutes one time when liquidity changed", () => {
    const p = failurePolicy(new TradeError("LIQUIDITY_CHANGED", "moved"));
    expect(p.retry).toBe("reroute");
    expect(p.maxRetries).toBe(1);
  });

  it("never retries UNKNOWN, policy, risk or execution rejection", () => {
    for (const code of [
      "TRANSACTION_UNKNOWN",
      "POLICY_BLOCK",
      "POSITION_LIMIT",
      "TRANSACTION_REJECTED",
      "MIN_OUT_FAILED",
    ] as const) {
      const p = failurePolicy(new TradeError(code, code));
      expect(p.retry).toBe("none");
      expect(p.maxRetries).toBe(0);
    }
  });

  it("refreshes once for genuinely transient RPC failure", () => {
    const p = failurePolicy(new TradeError("RPC_FAILURE", "node down"));
    expect(p.class).toBe("TEMPORARY_RPC_FAILURE");
    expect(p.retry).toBe("refresh");
    expect(p.maxRetries).toBe(1);
  });

  it("retries transient preparation exactly once", async () => {
    let calls = 0;
    const value = await withTransientPreparationRetry({
      prepare: async (_attempt, action) => {
        calls += 1;
        if (calls === 1) throw new TradeError("QUOTE_STALE", "old");
        expect(action).toBe("requote");
        return "fresh";
      },
    });
    expect(value).toBe("fresh");
    expect(calls).toBe(2);
  });

  it("never retries an execution rejection", async () => {
    let calls = 0;
    await expect(
      withTransientPreparationRetry({
        prepare: async () => {
          calls += 1;
          throw new TradeError("MIN_OUT_FAILED", "rejected");
        },
      }),
    ).rejects.toThrow("rejected");
    expect(calls).toBe(1);
  });
});
