import { describe, expect, it } from "vitest";
import { aiBudget, extractContent } from "./ai-analyst";

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
