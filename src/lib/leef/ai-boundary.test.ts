/**
 * Audit §8/§14 — the AI execution boundary, enforced as an import-graph test.
 *
 * The analyst (lib/leef/ai-analyst.ts) is reachable from DESKS ONLY. The
 * trade path — engine, gates, signer, policy firewall, reconcile — must never
 * import it, and the AI module itself must never import a signer. If a future
 * change wires AI into the trade path, this test fails at `npm test`, not in
 * production.
 *
 * AMENDED (Jev seam, C2): the Jev proposal path — jev-client.ts (browser →
 * /api/jev only) and ai-executor.ts (pure question/proposal logic) — MAY be
 * imported by use-bot-loop.ts, the single sanctioned seam. AI modules still
 * only PROPOSE: they are forbidden from importing sign/secret/session, the
 * TYPESAFE_API_KEY never appears in src/, and the browser never references
 * api.typesafe.ai directly.
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
      expect(src.includes("token-risk"), `${f} must not import the Jev token screen`).toBe(false);
    }
  });

  it("the Jev token screen cannot sign, touch secrets or reach the trade path", () => {
    for (const f of ["./token-risk.ts", "./token-risk-core.ts", "../../../api/token-risk.ts"]) {
      const src = read(f);
      expect(src.includes("lib/wallet"), `${f}`).toBe(false);
      expect(src.includes("signAndPush"), `${f}`).toBe(false);
      expect(src.includes("push_transaction"), `${f}`).toBe(false);
    }
    // the TypeSafe key is server-only: never referenced by client code
    expect(read("./token-risk.ts").includes("TYPESAFE_API_KEY")).toBe(false);
    expect(read("./token-risk-core.ts").includes("TYPESAFE_API_KEY")).toBe(false);
    expect(read("../../components/terminal/token-risk-notice.tsx").includes("TYPESAFE_API_KEY")).toBe(false);
  });

  it("the AI client itself cannot sign or touch secrets", () => {
    const src = read("./ai-analyst.ts");
    expect(src.includes("lib/wallet/sign")).toBe(false);
    expect(src.includes("wallet/secret")).toBe(false);
    expect(src.includes("signAndPush")).toBe(false);
    expect(src.includes("push_transaction")).toBe(false);
    expect(src.includes("session")).toBe(false);
  });

  it("the Jev proposal modules cannot sign, touch secrets, or reach the trade path", () => {
    for (const f of ["./jev-client.ts", "./ai-executor.ts", "../../../api/jev.ts"]) {
      const src = read(f);
      expect(src.includes("lib/wallet"), `${f}`).toBe(false);
      expect(src.includes("signAndPush"), `${f}`).toBe(false);
      expect(src.includes("push_transaction"), `${f}`).toBe(false);
      expect(src.includes("wallet/secret"), `${f}`).toBe(false);
      expect(src.includes("session"), `${f}`).toBe(false);
    }
  });

  it("the Jev key is server-only and the browser never calls TypeSafe directly", () => {
    expect(read("./jev-client.ts").includes("TYPESAFE_API_KEY")).toBe(false);
    expect(read("./ai-executor.ts").includes("TYPESAFE_API_KEY")).toBe(false);
    expect(read("./jev-client.ts").includes("typesafe.ai")).toBe(false);
    expect(read("./ai-executor.ts").includes("typesafe.ai")).toBe(false);
    // The ONLY TypeSafe endpoint references live in api/ serverless functions.
    expect(read("../../../api/jev.ts").includes("TYPESAFE_API_KEY")).toBe(true);
  });

  it("use-bot-loop is the ONLY trade-path module allowed at the Jev seam, and only via ai-executor/jev-client", () => {
    for (const f of TRADE_PATH) {
      const src = read(f);
      const seam = src.includes("ai-executor") || src.includes("jev-client");
      if (f.endsWith("use-bot-loop.ts")) {
        expect(seam, "the Jev seam belongs in use-bot-loop").toBe(true);
      } else {
        expect(seam, `${f} must not import the Jev proposal modules`).toBe(false);
      }
    }
  });

  it("the evidence journal is a sink, not a signer", () => {
    const src = read("./journal.ts");
    expect(src.includes("lib/wallet")).toBe(false);
    expect(src.includes("signAndPush")).toBe(false);
  });
});
