/**
 * Wallet + market advisor.
 *
 * Suggests overridable bot knobs from: quote-token balance, LEEF holdings,
 * CPU/NET/RAM, and LEEF-book depth versus that quote. Never auto-applies —
 * the desk shows the scan; the user applies or ignores it.
 *
 * Clip = floor, max position = ceiling. Suggestions stay inside those
 * semantics. Quote token is not only WAX — WAXUSDC, USDT, PARAUSD, etc.
 */
import { usdPriceOf } from "./cost-model";
import { DEFAULT_RISK, type BotRisk, type BotStrategy } from "./bot-engine";
import type { LeefSnapshot } from "./types";

export type AdvisorInput = {
  snap: LeefSnapshot;
  balances: Record<string, number>;
  quote: string;
  strategy: BotStrategy;
  cpuPct: number | null;
  netPct: number | null;
  ramPct: number | null;
};

export type AdvisorLine = { label: string; detail: string };

export type AdvisorSuggestion = {
  quote: string;
  risk: Pick<BotRisk, "clipWax" | "maxPositionWax" | "cooldownSec" | "maxTradesHour" | "maxImpactPct">;
  why: AdvisorLine[];
  warnings: string[];
  /** USD value of the quote-token stack used for sizing. */
  quoteUsd: number;
  quoteBalance: number;
};

const STABLEISH = new Set(["USDT", "USDC", "WAXUSDT", "WAXUSDC", "PARAUSD", "DAI"]);

/** Tokens the desk offers as quote (LEEF vs X). Universe + LEEF pool pairs. */
export function listQuoteTokens(snap: LeefSnapshot): string[] {
  const set = new Set<string>(["WAX", "WAXUSDC", "WAXUSDT", "USDT", "PARAUSD"]);
  for (const u of snap.universe) {
    if (u.symbol === "LEEF") continue;
    if (u.usdPrice > 0 && (u.tvlUsd >= 15 || STABLEISH.has(u.symbol))) set.add(u.symbol);
  }
  for (const p of snap.pools) {
    const s = p.pair.symbol.toUpperCase();
    if (s && s !== "LEEF") set.add(s);
  }
  return [...set].sort((a, b) => {
    const rank = (x: string) =>
      x === "WAX" ? 0 : STABLEISH.has(x) ? 1 : x === "TLM" ? 2 : 3;
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}

function roundClip(n: number): number {
  if (n < 1) return Math.max(0.1, Math.round(n * 10) / 10);
  if (n < 10) return Math.round(n * 10) / 10;
  return Math.round(n);
}

/**
 * Suggest clip / max / cooldown / hourly cap from this wallet + book.
 * Pure — no I/O. User must apply.
 */
export function suggestBotSettings(input: AdvisorInput): AdvisorSuggestion {
  const quote = input.quote.toUpperCase();
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

  // Floor: ~0.8–2% of quote stack, never below 0.1 units, never above 5% of stack.
  let clipFrac = 0.012;
  if (input.strategy === "dca") clipFrac = 0.008;
  if (input.strategy === "grid") clipFrac = 0.01;
  if (input.strategy === "volume" || input.strategy === "spread") clipFrac = 0.015;
  if (input.strategy === "signal") clipFrac = 0.012;
  if (tight) clipFrac *= 0.5;

  let clip = roundClip(Math.max(0.1, bal * clipFrac));
  const clipCap = roundClip(Math.max(0.1, bal * 0.05));
  clip = Math.min(clip, clipCap);

  // Ceiling: ~25% of quote stack (DCA 40%, volume 15%), shrunk if resources tight.
  let maxFrac = 0.25;
  if (input.strategy === "dca") maxFrac = 0.4;
  if (input.strategy === "volume") maxFrac = 0.15;
  if (tight) maxFrac *= 0.6;
  let maxPos = roundClip(Math.max(clip, bal * maxFrac));
  if (maxPos < clip) maxPos = clip;

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
  if (!(px > 0)) warnings.push(`${quote} has no USD mark — sizing uses token units only`);
  if (bal <= 0) warnings.push(`No ${quote} in this wallet — fund it or pick another quote token`);

  const leefBooks = input.snap.pools.filter((p) => p.pair.symbol.toUpperCase() === quote);
  const tvl = leefBooks.reduce((s, p) => s + p.tvlUsd, 0);
  if (quote !== "WAX" && leefBooks.length === 0) {
    warnings.push(`No LEEF/${quote} book in the snapshot — routing will hop via WAX if a path exists`);
  }
  if (tvl > 0 && quoteUsd > tvl * 0.15) {
    warnings.push(`Wallet ${quote} is large vs LEEF/${quote} TVL ($${tvl.toFixed(0)}) — keep clips small`);
    clip = roundClip(clip * 0.5);
    maxPos = Math.max(clip, roundClip(maxPos * 0.6));
  }

  why.push({
    label: "Wallet",
    detail: `${bal.toFixed(bal >= 10 ? 1 : 4)} ${quote}${px > 0 ? ` · $${quoteUsd.toFixed(2)}` : ""}`,
  });
  why.push({
    label: "Min clip",
    detail: `${clip} ${quote} (~${(clipFrac * 100).toFixed(1)}% of stack, floor 0.1)`,
  });
  why.push({
    label: "Max position",
    detail: `${maxPos} ${quote} (~${(maxFrac * 100).toFixed(0)}% of stack)`,
  });
  why.push({
    label: "Resources",
    detail: `CPU ${cpu != null ? `${(cpu * 100).toFixed(0)}%` : "—"} · NET ${
      net != null ? `${(net * 100).toFixed(0)}%` : "—"
    } · RAM ${ram != null ? `${(ram * 100).toFixed(0)}%` : "—"}${tight ? " · tight" : " · ok"}`,
  });
  if (leefBooks.length > 0) {
    why.push({
      label: "LEEF books",
      detail: `${leefBooks.length} LEEF/${quote} pool(s) · TVL $${tvl.toFixed(0)}`,
    });
  }

  return {
    quote,
    risk: {
      clipWax: clip,
      maxPositionWax: maxPos,
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
