/**
 * Platform fee tests — 0.001% to smart.ass. Precision-floored, never upward,
 * skipped below dust, exactly once per logical trade.
 */
import { describe, expect, it } from "vitest";
import {
  PLATFORM_FEE_ACCOUNT,
  PLATFORM_FEE_BPS,
  PLATFORM_FEE_MEMO,
  PLATFORM_FEE_RATE,
  platformFeeOn,
  platformFeeUsd,
} from "./platform-fee";
import { assertActionPolicy } from "@/lib/wallet/policy";

const WAX = { symbol: "WAX", contract: "eosio.token", decimals: 8 };
const LEEF = { symbol: "LEEF", contract: "leefmaincorp", decimals: 4 };

describe("platform fee math", () => {
  it("0.001% = 0.00001 rate = 0.1 bps — the exact spec values", () => {
    expect(PLATFORM_FEE_RATE).toBe(0.00001);
    expect(PLATFORM_FEE_BPS).toBe(0.1);
    expect(PLATFORM_FEE_ACCOUNT).toBe("smart.ass");
  });

  it("100 WAX → 0.001 WAX", () => {
    const fee = platformFeeOn(100, WAX)!;
    expect(fee.amount).toBeCloseTo(0.001, 12);
    expect(fee.quantity).toBe("0.00100000 WAX");
  });

  it("100,000 LEEF → 1 LEEF", () => {
    const fee = platformFeeOn(100_000, LEEF)!;
    expect(fee.amount).toBeCloseTo(1, 8);
    expect(fee.quantity).toBe("1.0000 LEEF");
  });

  it("10 USDC (6dp) → 0.0001 USDC", () => {
    const fee = platformFeeOn(10, { symbol: "USDC", contract: "eth.token", decimals: 6 })!;
    expect(fee.amount).toBeCloseTo(0.0001, 12);
  });

  it("0-decimal token: a 5000-unit trade fees 0.05 → floors to 0 units → skipped", () => {
    expect(
      platformFeeOn(5000, { symbol: "ZERO", contract: "z.token", decimals: 0 }),
    ).toBeNull();
  });

  it("dust trades skip the fee rather than inventing units", () => {
    // 0.5 LEEF at 4dp: fee = 0.000005 → 0 units.
    expect(platformFeeOn(0.5, LEEF)).toBeNull();
    expect(platformFeeOn(0, WAX)).toBeNull();
    expect(platformFeeOn(-5, WAX)).toBeNull();
  });

  it("never exceeds the configured rate under any rounding", () => {
    for (const amount of [1, 7.77, 99.999, 12_345.6789, 999_999.9999, 1e9]) {
      for (const decimals of [0, 3, 4, 6, 8]) {
        const fee = platformFeeOn(amount, { symbol: "T", contract: "t.token", decimals });
        if (!fee) continue;
        expect(fee.amount / amount).toBeLessThanOrEqual(PLATFORM_FEE_RATE + 1e-15);
      }
    }
  });

  it("3-decimal token floors to the unit, not the rate", () => {
    const fee = platformFeeOn(123.456, { symbol: "T3", contract: "t.token", decimals: 3 })!;
    expect(fee.amount).toBe(0.001); // 123.456×0.00001 = 0.00123456 → floor → 0.001
  });

  it("usd accounting helper", () => {
    const fee = platformFeeOn(100, WAX)!;
    expect(platformFeeUsd(fee, 2.61)).toBeCloseTo(0.00261, 8);
    expect(platformFeeUsd(null, 2.61)).toBe(0);
  });
});

describe("platform fee vs the policy firewall", () => {
  const feeAction = (over: Record<string, unknown> = {}, contract = "eosio.token") => ({
    contract,
    name: "transfer",
    plain: {
      from: "trader.leef",
      to: PLATFORM_FEE_ACCOUNT,
      quantity: "0.00100000 WAX",
      memo: PLATFORM_FEE_MEMO,
      ...over,
    },
  });
  const ctx = { platformFee: { maxByKey: { "WAX@eosio.token": 0.001 } } };

  it("passes with the canonical recipient, memo, token, and vouched amount", () => {
    expect(() => assertActionPolicy([feeAction()], "trader.leef", ctx)).not.toThrow();
  });

  it("rejects a redirected recipient (the constant is the only recipient)", () => {
    expect(() =>
      assertActionPolicy([feeAction({ to: "attacker.wa" })], "trader.leef", ctx),
    ).toThrow(/allowlisted AMMs/);
  });

  it("rejects a wrong memo", () => {
    expect(() =>
      assertActionPolicy([feeAction({ memo: "rent money" })], "trader.leef", ctx),
    ).toThrow(/canonical fee memo/);
  });

  it("rejects an amount above the vouched maximum", () => {
    expect(() =>
      assertActionPolicy([feeAction({ quantity: "5.00000000 WAX" })], "trader.leef", ctx),
    ).toThrow(/exceeds the vouched maximum/);
  });

  it("rejects when no fee context was vouched at all", () => {
    expect(() => assertActionPolicy([feeAction()], "trader.leef")).toThrow(
      /without a platform-fee policy context/,
    );
  });

  it("rejects a spoofed token contract for the fee", () => {
    expect(() =>
      assertActionPolicy([feeAction({}, "fake.token")], "trader.leef", ctx),
    ).toThrow();
  });
});
