import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCsp, connectOrigins, connectSrc } from "./csp";
import { DEFAULT_HISTORY_ENDPOINTS, DEFAULT_RPC_ENDPOINTS } from "@/lib/wax/endpoints";
import { DEFAULT_AI_GATEWAY } from "@/lib/leef/ai-analyst";
import { ROUTER } from "@/lib/wallet/alcor-route";
import { CORS_PROXY } from "@/lib/fetchJson";

const ROOT = path.resolve(import.meta.dirname, "../..");

/** Hosts that appear in src/lib only as links / docs / placeholders — never fetched. */
const NOT_FETCHED = new Set([
  "https://waxblock.io",
  "https://developer.mozilla.org",
  // Provenance comment for the vendored Telegram SDK — the app never fetches
  // from telegram.org (script-src is 'self' and the SDK ships in src/vendor).
  "https://telegram.org",
]);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("CSP allowlist", () => {
  it("connect-src has no wildcard schemes or hosts", () => {
    const src = connectSrc();
    for (const bad of ["https:", "wss:", "http:", "ws:", "*"]) expect(src).not.toContain(bad);
    for (const o of connectOrigins()) expect(o).not.toMatch(/\*/);
  });

  it("covers every endpoint constant the app fetches from", () => {
    const origins = new Set(connectOrigins());
    const needed = [
      ...DEFAULT_RPC_ENDPOINTS.map((e) => e.url),
      ...DEFAULT_HISTORY_ENDPOINTS.map((e) => e.url),
      ROUTER,
      CORS_PROXY,
      DEFAULT_AI_GATEWAY,
    ].map((u) => new URL(u).origin);
    for (const o of needed) expect(origins, o).toContain(o);
  });

  it("vercel.json Report-Only header is exactly buildCsp()", () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8")) as {
      headers: { source: string; headers: { key: string; value: string }[] }[];
    };
    const all = vercel.headers.find((h) => h.source === "/(.*)")!;
    const ro = all.headers.find((h) => h.key === "Content-Security-Policy-Report-Only");
    expect(ro?.value).toBe(buildCsp());
  });

  it("frame-src is narrowed to the wallet origin (no bare https:)", () => {
    const frame = buildCsp()
      .split("; ")
      .find((d) => d.startsWith("frame-src "))!;
    expect(frame.split(" ")).not.toContain("https:");
  });

  it("every https/wss literal in src/lib is allowlisted or known link-only", () => {
    const allowed = new Set(connectOrigins());
    const offenders: string[] = [];
    for (const file of walk(path.join(ROOT, "src/lib"))) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/\b(?:https|wss):\/\/[a-z0-9.-]+\.[a-z]{2,}/gi)) {
        const o = new URL(m[0]).origin;
        if (!allowed.has(o) && !NOT_FETCHED.has(o)) {
          offenders.push(`${path.relative(ROOT, file)}: ${o}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
