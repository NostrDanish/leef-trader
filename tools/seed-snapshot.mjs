#!/usr/bin/env node
/**
 * prebuild: write public/version.json (always) and public/seed-snapshot.json
 * (best-effort).
 *
 * The seed snapshot lets the terminal paint the hot LEEF Alcor book
 * instantly on first load; the live market engine replaces it seconds later
 * (refresh-behind). It is FAIL-SAFE by design: any network/parse failure
 * logs a warning and the build continues without a seed — the app already
 * handles a missing seed-snapshot.json.
 *
 * Offline / CI without network: the seed step skips gracefully, only
 * version.json is written.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pubDir = path.join(root, "public");

const ALCOR = "https://wax.alcor.exchange/api/v2";
/** Hard cap for the seed payload — it ships to every visitor. */
const MAX_BYTES = 200 * 1024;

/* ------------------------------------------------------------------ */
/* version.json — build stamp for the "new version available" banner   */
/* ------------------------------------------------------------------ */

function writeVersion() {
  let v;
  try {
    v = execSync("git rev-parse --short HEAD", {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    v = new Date().toISOString();
  }
  if (!v) v = new Date().toISOString();
  writeFileSync(path.join(pubDir, "version.json"), JSON.stringify({ v }) + "\n");
  console.log(`[prebuild] version.json v=${v}`);
}

/* ------------------------------------------------------------------ */
/* seed-snapshot.json — hot LEEF book, raw Alcor pool objects          */
/* ------------------------------------------------------------------ */

async function fetchJson(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const upper = (v) => String(v ?? "").toUpperCase();

function isLeefPool(p) {
  return [p?.tokenA, p?.tokenB].some(
    (t) => t && upper(t.symbol) === "LEEF" && t.contract === "leefmaincorp",
  );
}

/** WAX<->trusted-stable books: the WAX/USD anchor for instant USD prices. */
function isWaxStablePool(p) {
  const a = p?.tokenA;
  const b = p?.tokenB;
  if (!a || !b) return false;
  const syms = [upper(a.symbol), upper(b.symbol)];
  const hasWax = syms.includes("WAX") && [a.contract, b.contract].includes("eosio.token");
  const stables = ["WAXUSDC", "WAXUSDT", "USDT", "USDC", "DAI", "DUSD", "XUSDC"];
  return hasWax && syms.some((s) => stables.includes(s));
}

const volumeOf = (p) =>
  Number(p?.volumeUSD24 ?? p?.volume24USD ?? p?.volumeUsd24 ?? p?.volume24Usd ?? 0) || 0;

async function writeSeed() {
  const [list, token] = await Promise.all([
    fetchJson(`${ALCOR}/swap/pools`, 45_000),
    fetchJson(`${ALCOR}/tokens/leef-leefmaincorp`, 10_000).catch(() => null),
  ]);
  if (!Array.isArray(list)) throw new Error("Alcor pool list is not an array");

  const active = list.filter((p) => p && typeof p === "object" && p.active !== false);
  const leef = active.filter(isLeefPool).sort((a, b) => volumeOf(b) - volumeOf(a));
  if (leef.length === 0) throw new Error("no LEEF pools in the Alcor response");
  const aux = active.filter(isWaxStablePool).sort((a, b) => volumeOf(b) - volumeOf(a));

  const hint = token && Number(token.safe_usd_price ?? token.usd_price) > 0
    ? Number(token.safe_usd_price ?? token.usd_price)
    : undefined;

  // Trim to the size budget: aux books beyond the top anchors go first,
  // then the tail of the LEEF book (lowest volume) — the app re-ranks anyway.
  let auxKeep = aux.slice(0, 8);
  let leefKeep = leef;
  let json = "";
  for (;;) {
    json = JSON.stringify({
      v: 1,
      fetchedAt: new Date().toISOString(),
      leefUsdHint: hint,
      pools: [...leefKeep, ...auxKeep],
    });
    if (Buffer.byteLength(json) <= MAX_BYTES) break;
    if (auxKeep.length > 4) auxKeep = auxKeep.slice(0, 4);
    else if (leefKeep.length > 8) leefKeep = leefKeep.slice(0, Math.max(8, Math.floor(leefKeep.length * 0.8)));
    else break; // 8 hot pools exceed the cap — ship them anyway, still small.
  }

  writeFileSync(path.join(pubDir, "seed-snapshot.json"), json + "\n");
  console.log(
    `[prebuild] seed-snapshot.json: ${leefKeep.length} LEEF + ${auxKeep.length} WAX/stable pools, ` +
      `${(Buffer.byteLength(json) / 1024).toFixed(1)} KB`,
  );
}

/* ------------------------------------------------------------------ */

mkdirSync(pubDir, { recursive: true });
writeVersion();
try {
  await writeSeed();
} catch (err) {
  console.warn(
    `[prebuild] seed snapshot skipped (${err instanceof Error ? err.message : err}) — build continues without it.`,
  );
}
