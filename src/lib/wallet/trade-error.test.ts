import { describe, expect, it } from "vitest";
import { classifyTradeError, TradeError } from "./trade-error";
import {
  beginSigning,
  liveCapitalBlocked,
  markBroadcast,
  markConfirmed,
  markUnknown,
  unknownBlockReason,
} from "./trade-cycle";

describe("classifyTradeError", () => {
  it("keeps TradeError codes", () => {
    const e = new TradeError("QUOTE_TIMEOUT", "Alcor timed out");
    expect(classifyTradeError(e)).toEqual({ code: "QUOTE_TIMEOUT", message: "Alcor timed out" });
  });
  it("maps common strings", () => {
    expect(classifyTradeError(new Error("HTTP 429: slow down")).code).toBe("API_RATE_LIMIT");
    expect(classifyTradeError(new Error("WAX CPU 96% used")).code).toBe("INSUFFICIENT_CPU");
    expect(classifyTradeError(new Error("Policy blocked foreign receiver")).code).toBe("POLICY_BLOCK");
    expect(classifyTradeError(new Error("net edge 0.01% < required")).code).toBe("NET_EDGE_TOO_LOW");
  });
  it("extracts chain assert from an Alcor HTTP 500 instead of UNKNOWN", () => {
    const raw =
      'HTTP 500: {"code":500,"message":"Internal Service Error","error":{"code":3050003,"name":"eosio_assert_message_exception","what":"eosio_assert_message assertion failure","details":[{"message":"assertion failure with message: invalid amount"}]}}';
    const c = classifyTradeError(new Error(raw));
    expect(c.code).toBe("MIN_OUT_FAILED");
    expect(c.message.toLowerCase()).toMatch(/invalid amount/);
  });
  it("extracts the deepest details message, not the generic outer one", () => {
    const raw =
      '{"code":500,"message":"Internal Service Error","error":{"code":3050003,"details":[{"message":"assertion failure with message: overdrawn balance"}]}}';
    const c = classifyTradeError(new Error(raw));
    expect(c.message).toMatch(/overdrawn balance/);
    expect(c.message).not.toMatch(/Internal Service Error/i);
  });
});

describe("trade-cycle lock", () => {
  it("blocks a second live sign and never retries UNKNOWN", () => {
    markConfirmed();
    expect(liveCapitalBlocked()).toBe(false);
    expect(beginSigning()).toBe(true);
    expect(liveCapitalBlocked()).toBe(true);
    expect(beginSigning()).toBe(false);
    markBroadcast("aa".repeat(32));
    expect(liveCapitalBlocked()).toBe(true);
    markUnknown("aa".repeat(32));
    expect(liveCapitalBlocked()).toBe(true);
    expect(unknownBlockReason()).toMatch(/UNKNOWN/);
    expect(beginSigning()).toBe(false);
    markConfirmed();
    expect(liveCapitalBlocked()).toBe(false);
  });
});
