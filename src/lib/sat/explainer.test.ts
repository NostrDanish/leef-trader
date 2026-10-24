import { describe, expect, it } from "vitest";
import { ACCOUNTS, BLOCKS, LINKS, REVENUE_SPLIT, SAT_ALLOCATION, TXS } from "./explainer";

const pct = (rows: [string, ...unknown[]][]) => rows.reduce((t, r) => t + Number(r[0].replace("%", "")), 0);

describe("about / explainer content", () => {
  it("allocation and revenue split each add up to 100%", () => {
    expect(pct(SAT_ALLOCATION)).toBe(100);
    expect(pct(REVENUE_SPLIT)).toBe(100);
  });
  it("uses the official community link only", () => {
    const all = JSON.stringify({ LINKS, BLOCKS, ACCOUNTS });
    expect(LINKS.community).toBe("https://t.me/leefmaincorp");
    expect(LINKS.explainer).toBe("https://github.com/leeftoken/leef-trader/blob/main/docs/EXPLAINER.md");
    expect(all).not.toMatch(/t\.me\/leeftoken/i);
  });
  it("lists every SAT / LEEF account", () => {
    const names = ACCOUNTS.map((r) => r[0]);
    for (const a of ["sattoken1111", "smartatrader", "smartaadmin1", "smartafees11", "smartabot111", "leefmaincorp", "leefstakerio", "swap.alcor", "wrap.alcor", "eosio.token"]) expect(names).toContain(a);
  });
  it("tx ids are 64-char hex and nothing looks like a key", () => {
    for (const [, id] of TXS) expect(id).toMatch(/^[0-9a-f]{64}$/);
    const all = JSON.stringify({ LINKS, BLOCKS, ACCOUNTS, TXS });
    expect(all).not.toMatch(/PVT_K1_|\b5[HJK][1-9A-HJ-NP-Za-km-z]{49}\b/);
  });
});
