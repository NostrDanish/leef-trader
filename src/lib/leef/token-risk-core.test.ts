import { describe, expect, it } from "vitest";
import {
  buildJevRequest,
  isKnownToken,
  parseJevResponse,
  parseTokenRiskRequest,
  riskLevel,
} from "./token-risk-core";

describe("token-risk-core", () => {
  it("validates untrusted input", () => {
    expect(parseTokenRiskRequest({ tokens: [{ symbol: "waxdao", contract: "MDCRYPTONFTS" }] })).toEqual([
      { symbol: "WAXDAO", contract: "mdcryptonfts" },
    ]);
    expect(parseTokenRiskRequest({ tokens: [] })).toBeNull();
    expect(parseTokenRiskRequest({ tokens: [{ symbol: "BAD SYMBOL", contract: "x" }] })).toBeNull();
    expect(parseTokenRiskRequest({ tokens: [{ symbol: "A", contract: "toolongcontract1" }] })).toBeNull();
    expect(parseTokenRiskRequest({ tokens: Array(5).fill({ symbol: "A", contract: "a" }) })).toBeNull();
    expect(parseTokenRiskRequest("nope")).toBeNull();
  });

  it("never flags known tokens", () => {
    expect(isKnownToken({ symbol: "USDC", contract: "wrap.alcor" })).toBe(true);
    expect(isKnownToken({ symbol: "WAXDAO", contract: "mdcryptonfts" })).toBe(false);
  });

  it("batches every token into one request with two Nouls each", () => {
    const req = buildJevRequest([
      { symbol: "EUSD", contract: "futureusd.gm" },
      { symbol: "WAXDAO", contract: "mdcryptonfts" },
    ]);
    expect(Object.keys(req.questions)).toEqual(["t0_copycat", "t0_scam", "t1_copycat", "t1_scam"]);
    expect(req.model).toBe("jev-latest");
  });

  it("parses answers and drops malformed ones (fail-open)", () => {
    const toks = [
      { symbol: "EUSD", contract: "futureusd.gm" },
      { symbol: "X", contract: "x" },
    ];
    const r = parseJevResponse(
      { answers: { t0_copycat: { type: "noul", noul: 0.3 }, t0_scam: { type: "noul", noul: 0.8 }, t1_copycat: { type: "noul", noul: 2 } } },
      toks,
    );
    expect(r).toEqual({ "EUSD@futureusd.gm": { copycat: 0.3, scam: 0.8 } });
    expect(parseJevResponse(null, toks)).toEqual({});
  });

  it("maps probabilities to advisory levels", () => {
    expect(riskLevel(undefined)).toBe("ok");
    expect(riskLevel({ copycat: 0.2, scam: 0.4 })).toBe("ok");
    expect(riskLevel({ copycat: 0.55, scam: 0.1 })).toBe("caution");
    expect(riskLevel({ copycat: 0.9, scam: 0.1 })).toBe("warning");
  });
});
