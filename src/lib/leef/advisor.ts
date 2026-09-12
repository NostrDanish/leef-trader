/**
 * Wallet + market advisor.
 *
 * Suggests overridable bot knobs from: quote-token balance, LEEF holdings,
 * CPU/NET/RAM, and LEEF-book depth versus that quote. Never auto-applies —
 * the desk shows the scan; the user applies or ignores it.
 *
 * User-facing risk is USD VALUE. Token amounts are derived at the live mark.
 */
import { usdPriceOf } from "./cost-model";
import { DEFAULT_RISK, type BotRisk, type BotStrategy } from "./bot-engine";
import { DEFAULT_MAX_POSITION_USD, DEFAULT_MIN_TRADE_USD } from "./risk-usd";
import type { LeefSnapshot } from "./types";

export type AdvisorInput = {
  snap: LeefSnapshot;
  balances: Record<string, number>;
  base: string;
  quote: string;
  /** Tokens the user wants to focus on (empty = no extra bias). */
  focus: string[];
  strategy: BotStrategy;
  cpuPct: number | null;
  netPct: number | null;
  ramPct: number | null;
};

export type AdvisorLine = { label: string; detail: string };

export type AdvisorSuggestion = {
  base: string;
  quote: string;
  risk: Pick<
    BotRisk,
    "minTradeUsd" | "maxPositionUsd" | "cooldownSec" | "maxTradesHour" | "maxImpactPct"
  >;
  why: AdvisorLine[];
  warnings: string[];
  /** USD value of the quote-token stack used for sizing. */
  quoteUsd: number;
  quoteBalance: number;
};

const STABLEISH = new Set(["USDT", "USDC", "WAXUSDT", "WAXUSDC", "PARAUSD", "DAI"]);

const CORE = ["LEEF", "WAX", "WAXUSDC", "WAXUSDT", "USDT", "PARAUSD"] as const;

/** Bases you can accumulate (LEEF first, then other liquid names). */
export function listBaseTokens(snap: LeefSnapshot): string[] {
  const set = new Set<string>(["LEEF"]);
  for (const u of snap.universe) {
    if (u.symbol === "WAX") continue;
    if (u.usdPrice > 0 && u.tvlUsd >= 20) set.add(u.symbol);
  }
  for (const p of snap.pools) set.add(p.leef.symbol.toUpperCase());
  return [...set].sort((a, b) => (a === "LEEF" ? -1 : b === "LEEF" ? 1 : a.localeCompare(b)));
}

/** Quote side: WAX, stables, and whatever LEEF (or the base) actually books against. */
export function listQuoteTokens(snap: LeefSnapshot, base = "LEEF"): string[] {
  const b = base.toUpperCase();
  const set = new Set<string>(["WAX", "WAXUSDC", "WAXUSDT", "USDT", "PARAUSD"]);
  for (const u of snap.universe) {
    if (u.symbol === b) continue;
    if (u.usdPrice > 0 && (u.tvlUsd >= 15 || STABLEISH.has(u.symbol))) set.add(u.symbol);
  }
  for (const p of snap.pools) {
    const s = p.pair.symbol.toUpperCase();
    if (s && s !== b) set.add(s);
  }
  set.delete(b);
  return [...set].sort((a, c) => {
    const rank = (x: string) =>
      x === "WAX" ? 0 : STABLEISH.has(x) ? 1 : x === "TLM" ? 2 : 3;
    return rank(a) - rank(c) || a.localeCompare(c);
  });
}

export const FOCUS_PRESETS = CORE;

/** Pick the deepest LEEF (or base) book vs a quote the wallet actually holds. */
export function suggestPair(
  snap: LeefSnapshot,
  balances: Record<string, number>,
  focus: string[],
): { base: string; quote: string; reason: string } {
  const focusUp = focus.map((s) => s.toUpperCase());
  const base = focusUp.includes("LEEF") || focusUp.length === 0 ? "LEEF" : focusUp[0]!;
  const quotes = listQuoteTokens(snap, base);
  let best = "WAX";
  let bestScore = -1;
  let reason = "Default LEEF/WAX";
  for (const q of quotes) {
    const bal = balances[q] ?? 0;
    const px = usdPriceOf(q, snap);
    const usd = bal * px;
    const books = snap.pools.filter((p) => p.pair.symbol.toUpperCase() === q);
    const tvl = books.reduce((s, p) => s + p.tvlUsd, 0);
    const focusBoost = focusUp.includes(q) ? 1.4 : 1;
    const score = (usd + 1) * (tvl + 1) * focusBoost;
    if (score > bestScore && (bal > 0 || q === "WAX")) {
      best = q;
      bestScore = score;
      reason =
        books.length > 0
          ? `${books.length} ${base}/${q} book(s), wallet ${bal.toFixed(bal >= 10 ? 1 : 4)} ${q}`
          : `Wallet holds ${q}; hops via WAX if no direct ${base}/${q} book`;
    }
  }
  return { base, quote: best, reason };
}

function roundUsd(n: number): number {
  if (n < 0.1) return Math.max(DEFAULT_MIN_TRADE_USD, Math.round(n * 100) / 100);
  if (n < 1) return Math.round(n * 100) / 100;
  if (n < 10) return Math.round(n * 10) / 10;
  return Math.round(n);
}

/**
 * Suggest min trade / max position / cooldown / hourly cap from this wallet + book.
 * Pure — no I/O. User must apply. Never suggests more USD than the wallet holds.
 */
export function suggestBotSettings(input: AdvisorInput): AdvisorSuggestion {
  const quote = input.quote.toUpperCase();
  const base = (input.base ?? "LEEF").toUpperCase();
  const px = usdPriceOf(quote, input.snap);
  const bal = input.balances[quote] ?? 0;
  const quoteUsd = bal * px;
  const why: AdvisorLine[] = [];
  const warnings: string[] = [];

  const cpu = input.cpuPct;
  const net = input.netPct;
  const ram = input.ramPct;
  const tight =
    (cpu != null && cpu > 0.85) || (net != null && net > 0.9) || (ram != null && ram > 0.9);

  let clipFrac = 0.012;
  if (input.strategy === "dca") clipFrac = 0.008;
  if (input.strategy === "grid") clipFrac = 0.01;
  if (input.strategy === "volume" || input.strategy === "spread") clipFrac = 0.015;
  if (input.strategy === "signal") clipFrac = 0.012;
  if (tight) clipFrac *= 0.5;

  const walletUsd = px > 0 ? quoteUsd : 0;
  let minTrade = roundUsd(Math.max(DEFAULT_MIN_TRADE_USD, walletUsd * clipFrac));
  const clipCap = roundUsd(Math.max(DEFAULT_MIN_TRADE_USD, walletUsd * 0.05));
  minTrade = Math.min(minTrade, clipCap);

  let maxFrac = 0.25;
  if (input.strategy === "dca") maxFrac = 0.4;
  if (input.strategy === "volume") maxFrac = 0.15;
  if (tight) maxFrac *= 0.6;

  // Never suggest exposure above wallet OR the product ceiling.
  const walletCap = walletUsd > 0 ? walletUsd : DEFAULT_MAX_POSITION_USD;
  let maxPos = roundUsd(Math.max(minTrade, Math.min(walletCap * maxFrac, DEFAULT_MAX_POSITION_USD, walletCap)));
  if (maxPos < minTrade) maxPos = minTrade;

  let cooldown = DEFAULT_RISK.cooldownSec;
  let hourly = DEFAULT_RISK.maxTradesHour;
  let impact = DEFAULT_RISK.maxImpactPct;
  if (input.strategy === "dca") cooldown = 120;
  if (input.strategy === "spread" || input.strategy === "volume") cooldown = 45;
  if (tight) {
    cooldown = Math.round(cooldown * 1.8);
    hourly = Math.max(3, Math.floor(hourly / 2));
    impact = Math.min(impact, 1.5);
  }
  if (cpu != null && cpu > 0.92) {
    cooldown = Math.max(cooldown, 180);
    hourly = Math.min(hourly, 4);
    warnings.push(`CPU ${(cpu * 100).toFixed(0)}% used — slower cadence, smaller clips`);
  }
  if (net != null && net > 0.95) warnings.push(`NET ${(net * 100).toFixed(0)}% used — trades may fail`);
  if (ram != null && ram > 0.95) warnings.push(`RAM ${(ram * 100).toFixed(0)}% used — pause until you free RAM`);
  if (!(px > 0)) warnings.push(`${quote} has no USD mark — cannot convert value limits to token size`);
  if (bal <= 0) warnings.push(`No ${quote} in this wallet — fund it or pick another quote token`);

  const leefBooks = input.snap.pools.filter((p) => p.pair.symbol.toUpperCase() === quote);
  const tvl = leefBooks.reduce((s, p) => s + p.tvlUsd, 0);
  if (quote !== "WAX" && leefBooks.length === 0) {
    warnings.push(`No ${base}/${quote} book in the snapshot — routing will hop via WAX if a path exists`);
  }
  if (tvl > 0 && quoteUsd > tvl * 0.15) {
    warnings.push(`Wallet ${quote} is large vs ${base}/${quote} TVL ($${tvl.toFixed(0)}) — keep clips small`);
    minTrade = roundUsd(Math.max(DEFAULT_MIN_TRADE_USD, minTrade * 0.5));
    maxPos = Math.max(minTrade, roundUsd(maxPos * 0.6));
  }

  why.push({
    label: "Wallet",
    detail: `${bal.toFixed(bal >= 10 ? 1 : 4)} ${quote}${px > 0 ? ` · $${quoteUsd.toFixed(2)}` : ""}`,
  });
  why.push({
    label: "Min trade",
    detail: `$${minTrade.toFixed(minTrade < 1 ? 2 : 2)} (~${(clipFrac * 100).toFixed(1)}% of stack)`,
  });
  why.push({
    label: "Max position",
    detail: `$${maxPos.toFixed(maxPos < 10 ? 2 : 0)} (~${(maxFrac * 100).toFixed(0)}% of stack, cap $${DEFAULT_MAX_POSITION_USD.toFixed(0)})`,
  });
  if (px > 0) {
    why.push({
      label: "Equivalent",
      detail: `${(minTrade / px).toFixed(px < 0.1 ? 2 : 2)}–${(maxPos / px).toFixed(2)} ${quote} at $${px.toFixed(px < 0.1 ? 4 : 4)}`,
    });
  }
  why.push({
    label: "Resources",
    detail: `CPU ${cpu != null ? `${(cpu * 100).toFixed(0)}%` : "—"} · NET ${
      net != null ? `${(net * 100).toFixed(0)}%` : "—"
    } · RAM ${ram != null ? `${(ram * 100).toFixed(0)}%` : "—"}${tight ? " · tight" : " · ok"}`,
  });
  if (leefBooks.length > 0) {
    why.push({
      label: "Books",
      detail: `${leefBooks.length} ${base}/${quote} pool(s) · TVL $${tvl.toFixed(0)}`,
    });
  }
  if (input.focus.length > 0) {
    why.push({
      label: "Focus",
      detail: input.focus.join(", "),
    });
  }

  return {
    base,
    quote,
    risk: {
      minTradeUsd: minTrade,
      maxPositionUsd: maxPos,
      cooldownSec: cooldown,
      maxTradesHour: hourly,
      maxImpactPct: impact,
    },
    why,
    warnings,
    quoteUsd,
    quoteBalance: bal,
  };
}
