import { describe, expect, it } from "vitest";
import { aiBudget, extractContent, extractGrowthTargets } from "./ai-analyst";

describe("extractContent", () => {
  it("parses an OpenAI-style chat completion", () => {
    const body = {
      model: "deepseek/deepseek-v4-flash",
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: "Book is thin but stable",
              trade_authorization: false,
            }),
          },
        },
      ],
    };
    const out = extractContent(body);
    expect(out.model).toBe("deepseek/deepseek-v4-flash");
    expect((out.content as { summary: string }).summary).toBe("Book is thin but stable");
  });

  it("keeps unparseable content as a summary fallback", () => {
    const body = { choices: [{ message: { content: "not json at all" } }] };
    const out = extractContent(body);
    expect((out.content as { summary: string }).summary).toBe("not json at all");
    expect(out.raw).toBe("not json at all");
  });

  it("accepts a direct structured object (no choices wrapper)", () => {
    const out = extractContent({ summary: "direct", confidence: 0.7 });
    expect((out.content as { confidence: number }).confidence).toBe(0.7);
  });

  it("throws bad_response when there is no content anywhere", () => {
    expect(() => extractContent({ choices: [{ message: {} }] })).toThrowError(
      /no message content/i,
    );
  });
});

describe("aiBudget", () => {
  it("starts with a full local budget", () => {
    const b = aiBudget();
    expect(b.remaining).toBeGreaterThan(0);
    expect(b.remaining).toBeLessThanOrEqual(18);
    expect(b.resetInSec).toBe(0);
  });
});

describe("extractGrowthTargets", () => {
  const candidates = ["LEEF", "WAX", "TLM", "WAXUSDC", "TACO"];

  it("reads a structured targets array and renormalizes weights", () => {
    const out = extractGrowthTargets(
      { targets: [{ symbol: "leef", weight: 60 }, { symbol: "TLM", weight: 20 }] },
      candidates,
    );
    expect(out).not.toBeNull();
    expect(out!.map((t) => t.symbol)).toEqual(["LEEF", "TLM"]);
    expect(out![0]!.weight).toBeCloseTo(75);
    expect(out![1]!.weight).toBeCloseTo(25);
  });

  it("drops symbols that are not in the candidate list", () => {
    const out = extractGrowthTargets(
      { targets: [{ symbol: "LEEF", weight: 1 }, { symbol: "SCAM", weight: 99 }] },
      candidates,
    );
    expect(out!.map((t) => t.symbol)).toEqual(["LEEF"]);
    expect(out![0]!.weight).toBeCloseTo(100);
  });

  it("falls back to scanning the content for mentioned candidates", () => {
    const out = extractGrowthTargets(
      { summary: "I'd accumulate LEEF and TACO here; avoid thin books.", trade_authorization: false },
      candidates,
    );
    expect(out!.map((t) => t.symbol)).toEqual(["LEEF", "TACO"]);
    expect(out![0]!.weight).toBeCloseTo(50);
  });

  it("does not substring-match (WAXUSDC is not a WAX mention)", () => {
    const out = extractGrowthTargets({ summary: "WAXUSDC only." }, candidates);
    expect(out!.map((t) => t.symbol)).toEqual(["WAXUSDC"]);
  });

  it("caps at 5 targets and returns null on no match", () => {
    const many = extractGrowthTargets(
      { targets: ["A", "B", "C", "D", "E", "F", "G"].map((s) => ({ symbol: s, weight: 1 })) },
      ["A", "B", "C", "D", "E", "F", "G"],
    );
    expect(many).toHaveLength(5);
    expect(extractGrowthTargets({ summary: "no tokens here" }, candidates)).toBeNull();
  });
});
