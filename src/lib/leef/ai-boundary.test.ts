/**
 * Audit §8/§14 — the AI execution boundary, enforced as an import-graph test.
 *
 * The analyst (lib/leef/ai-analyst.ts) is reachable from DESKS ONLY. The
 * trade path — engine, gates, signer, policy firewall, reconcile — must never
 * import it, and the AI module itself must never import a signer. If a future
 * change wires AI into the trade path, this test fails at `npm test`, not in
 * production.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

/** Files that decide, gate, sign, broadcast or reconcile capital movement. */
const TRADE_PATH = [
  "./bot-engine.ts",
  "./net-edge.ts",
  "./exact-gate.ts",
  "./growth-engine.ts",
  "./route-optimizer.ts",
  "./journal.ts",
  "./platform-fee.ts",
  "./learning.ts",
  "./learning-store.ts",
  "../wallet/sign.ts",
  "../wallet/trade.ts",
  "../wallet/policy.ts",
  "../wallet/reconcile.ts",
  "../wallet/execution-coordinator.ts",
  "../../components/terminal/use-bot-loop.ts",
  "../../components/terminal/use-portfolio-loop.ts",
];

describe("AI execution boundary", () => {
  it("no trade-path module imports the AI client", () => {
    for (const f of TRADE_PATH) {
      const src = read(f);
      expect(src.includes("ai-analyst"), `${f} must not import ai-analyst`).toBe(false);
      expect(src.includes("aiTask"), `${f} must not call aiTask`).toBe(false);
    }
  });

  it("the AI client itself cannot sign or touch secrets", () => {
    const src = read("./ai-analyst.ts");
    expect(src.includes("lib/wallet/sign")).toBe(false);
    expect(src.includes("wallet/secret")).toBe(false);
    expect(src.includes("signAndPush")).toBe(false);
    expect(src.includes("push_transaction")).toBe(false);
    expect(src.includes("session")).toBe(false);
  });

  it("the evidence journal is a sink, not a signer", () => {
    const src = read("./journal.ts");
    expect(src.includes("lib/wallet")).toBe(false);
    expect(src.includes("signAndPush")).toBe(false);
  });
});
