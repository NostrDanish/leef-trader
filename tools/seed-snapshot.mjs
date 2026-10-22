#!/usr/bin/env node
/**
 * prebuild: write public/version.json (always) and public/seed-snapshot.json
 * (best-effort).
 *
 * Pool data comes from Alcor's filtered pool endpoints (LEEF on either
 * side, plus each WAX/trusted-stable pair) — not the ~12 MB unfiltered
 * `/swap/pools` list. The seed snapshot lets the terminal paint the hot
 * LEEF Alcor book instantly on first load; the live market engine replaces
 * it seconds later (refresh-behind). It is FAIL-SAFE by design: any
 * network/parse failure logs a warning and the build continues without a
 * seed — the app already handles a missing seed-snapshot.json.
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
/** Alcor id of the LEEF token (symbol-contract, lowercase). */
const LEEF_ID = "leef-leefmaincorp";
/** eosio.token WAX. Paired with each trusted stable instead of the 12 MB book. */
const WAX_ID = "wax-eosio.token";
/**
 * Alcor token ids for TRUSTED_STABLES in src/lib/market/stables.ts.
 * `tokenA`+`tokenB` returns the pair in either order.
 */
const WAX_STABLE_IDS = [
  "waxusdc-eth.token",
  "waxusdt-eth.token",
  "usdt-usdt.alcor",
  "parausd-parareserves",
  "usdc-wrap.alcor",
  "usdt-wrap.alcor",
];

function poolsUrl(params) {
  const url = new URL(`${ALCOR}/swap/pools`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function asPools(raw) {
  return Array.isArray(raw) ? raw : [];
}

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

async function fetchJson(url, timeoutMs, maxBytes = 1024 * 1024) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const buf = await res.arrayBuffer();
    // The unfiltered /swap/pools payload is ~12 MB. A filter the server
    // ignored must not be parsed — that is what made every build slow.
    if (buf.byteLength > maxBytes) {
      throw new Error(
        `response from ${url} is ${(buf.byteLength / 1024).toFixed(0)} KB (cap ${maxBytes})`,
      );
    }
    return JSON.parse(new TextDecoder().decode(buf));
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
  const stables = ["WAXUSDC", "WAXUSDT", "USDT", "USDC", "PARAUSD"];
  return hasWax && syms.some((s) => stables.includes(s));
}

const volumeOf = (p) =>
  Number(p?.volumeUSD24 ?? p?.volume24USD ?? p?.volumeUsd24 ?? p?.volume24Usd ?? 0) || 0;

async function writeSeed() {
  const t0 = Date.now();
  // Filtered reads: two LEEF sides + one request per WAX/trusted-stable pair.
  // The unfiltered list is ~12 MB and was the slow part of `npm run build`.
  const [leefA, leefB, token, ...stableLists] = await Promise.all([
    fetchJson(poolsUrl({ tokenA: LEEF_ID }), 12_000),
    fetchJson(poolsUrl({ tokenB: LEEF_ID }), 12_000),
    fetchJson(`${ALCOR}/tokens/${LEEF_ID}`, 8_000).catch(() => null),
    ...WAX_STABLE_IDS.map((id) =>
      fetchJson(poolsUrl({ tokenA: WAX_ID, tokenB: id }), 8_000).catch(() => []),
    ),
  ]);

  const byId = new Map();
  for (const pool of [
    ...asPools(leefA),
    ...asPools(leefB),
    ...stableLists.flatMap(asPools),
  ]) {
    if (pool && typeof pool === "object" && pool.id != null && !byId.has(pool.id)) {
      byId.set(pool.id, pool);
    }
  }
  const list = [...byId.values()];
  if (list.length === 0) throw new Error("Alcor returned no pools for the seed filters");

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
      `${(Buffer.byteLength(json) / 1024).toFixed(1)} KB in ${Date.now() - t0} ms`,
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
