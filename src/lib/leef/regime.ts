/**
 * Market Regime Engine — one deterministic classification per evaluation,
 * shared by every strategy.
 *
 * Strategies don't each get to decide "is this a trend?". The regime engine
 * reads the same 30s print series and the cross-pool book once, classifies,
 * and the strategies/ensemble consume the verdict:
 *
 *   dislocation  — pools disagree (arb territory; directional entries off)
 *   trend_up     — EMA fast > slow with enough separation, vol acceptable
 *   trend_down   — inverse. Dip-buying is suppressed, not "a dip"
 *   high_vol     — size down, arb up
 *   low_vol      — tighter spreads OK
 *   range        — mean reversion / grid territory
 *   unknown      — warming up; no vetoes
 *
 * Everything here is pure math on the cached series — no I/O.
 */

export type MarketRegime =
  | "trend_up"
  | "trend_down"
  | "range"
  | "high_vol"
  | "low_vol"
  | "dislocation"
  | "unknown";

export type RegimeVerdict = {
  regime: MarketRegime;
  /** EMA(fast)−EMA(slow) separation, percent of price. */
  trendSepPct: number;
  /** Realized vol per print, percent. */
  volPct: number;
  /** Cross-pool price disagreement, percent (0 when one book). */
  dislocationPct: number;
  /** 0–1: how much data backs this classification. */
  confidence: number;
  explain: string[];
};

export type RegimeInput = {
  /** Bot USD print series (oldest → newest). */
  series: { t: number; usd: number }[];
  /** Pool spot prices for dislocation detection (USD per unit of base). */
  poolPricesUsd?: number[];
};

/* ------------------------------------------------------------------ */
/* Danger score — one unified defensive number                         */
/* ------------------------------------------------------------------ */

export type DangerBand = "normal" | "cautious" | "reduced" | "selective" | "hold";

export type DangerVerdict = {
  /** 0–100. */
  score: number;
  band: DangerBand;
  /** Size multiplier for entries (1 = full size). Never blocks exits. */
  sizeFactor: number;
  explain: string[];
};

/**
 * One defensive number every strategy shares, instead of each inventing its
 * own. Inputs are whatever this evaluation already knows — no extra I/O.
 *
 *   0–20 normal · 20–40 cautious · 40–60 reduced · 60–80 selective · 80+ HOLD
 *
 * Danger is an ENTRY gate only. Exits and risk actions always fire.
 */
export function dangerScore(opts: {
  /** Age of the book this decision would act on. */
  quoteAgeMs: number;
  maxQuoteAgeMs: number;
  /** Per-print realized volatility, percent (from classifyRegime). */
  volPct: number;
  /** Cross-pool price disagreement, percent (from classifyRegime). */
  dislocationPct: number;
  /** Deepest pool TVL — thin books are dangerous. */
  liquidityUsd?: number;
  /** Execution errors in the recent window (RPC/quote/venue failures). */
  recentFailures?: number;
}): DangerVerdict {
  const explain: string[] = [];
  let score = 0;

  // Stale book — the single biggest silent killer.
  const ageFrac = Math.min(1.5, opts.quoteAgeMs / Math.max(1, opts.maxQuoteAgeMs));
  const freshPts = Math.round(Math.min(1, ageFrac) * 25);
  if (freshPts > 0) explain.push(`book ${Math.round(opts.quoteAgeMs / 1000)}s old +${freshPts}`);
  score += freshPts;

  // Volatility.
  const volPts = Math.round(Math.min(1, opts.volPct / 1.5) * 25);
  if (volPts >= 8) explain.push(`vol ${opts.volPct.toFixed(2)}%/print +${volPts}`);
  score += volPts;

  // Pool disagreement.
  const disPts = Math.round(Math.min(1, opts.dislocationPct / 1.5) * 20);
  if (disPts >= 6) explain.push(`pools disagree ${opts.dislocationPct.toFixed(2)}% +${disPts}`);
  score += disPts;

  // Liquidity.
  if (opts.liquidityUsd != null) {
    const liqPts =
      opts.liquidityUsd >= 5_000 ? 0 : Math.round(Math.min(1, 5_000 / Math.max(50, opts.liquidityUsd) - 1) * 15);
    if (liqPts >= 5) explain.push(`thin book $${Math.round(opts.liquidityUsd)} +${liqPts}`);
    score += liqPts;
  }

  // Recent execution failures (infrastructure stress, not alpha).
  const fails = opts.recentFailures ?? 0;
  const failPts = Math.min(15, fails * 5);
  if (failPts > 0) explain.push(`${fails} recent error${fails === 1 ? "" : "s"} +${failPts}`);
  score += failPts;

  score = Math.min(100, score);
  const band: DangerBand =
    score >= 80 ? "hold" : score >= 60 ? "selective" : score >= 40 ? "reduced" : score >= 20 ? "cautious" : "normal";
  const sizeFactor =
    band === "hold" ? 0 : band === "selective" ? 0.5 : band === "reduced" ? 0.8 : band === "cautious" ? 0.9 : 1;
  if (explain.length === 0) explain.push("book fresh · calm tape · no recent errors");
  return { score, band, sizeFactor, explain };
}

import { realizedVolPerSec } from "./cost-model";

const MIN_PRINTS = 34;
const EMA_FAST = 8;
const EMA_SLOW = 21;
/** Trend needs fast/slow separation beyond this fraction of per-print vol. */
const TREND_SIGMA = 1.1;
const HIGH_VOL_PCT = 0.9;
const LOW_VOL_PCT = 0.12;
const DISLOCATION_PCT = 0.35;

function emaLast(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i]! * k + ema * (1 - k);
  return ema;
}

/**
 * One volatility source for the whole app: the cost model's per-second
 * realized vol, scaled to the observed print cadence. Regime, grid and the
 * cost model can no longer disagree about the same tape.
 */
function volPerPrintPct(series: { t: number; usd: number }[]): number {
  const perSec = realizedVolPerSec(series);
  if (!(perSec > 0)) return 0;
  const pts = series.slice(-40);
  let dtSum = 0;
  for (let i = 1; i < pts.length; i++) dtSum += (pts[i]!.t - pts[i - 1]!.t) / 1000;
  const secPerTick = pts.length > 1 ? dtSum / (pts.length - 1) : 30;
  return perSec * Math.sqrt(secPerTick > 0 ? secPerTick : 30) * 100;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function classifyRegime(input: RegimeInput): RegimeVerdict {
  const { series } = input;
  if (series.length < MIN_PRINTS) {
    return {
      regime: "unknown",
      trendSepPct: 0,
      volPct: 0,
      dislocationPct: 0,
      confidence: 0,
      explain: [`warming up — ${series.length}/${MIN_PRINTS} prints`],
    };
  }

  const closes = series.map((p) => p.usd).filter((v) => v > 0);
  const fast = emaLast(closes, EMA_FAST);
  const slow = emaLast(closes, EMA_SLOW);
  const last = closes[closes.length - 1] ?? 0;
  const trendSepPct = fast != null && slow != null && last > 0 ? ((fast - slow) / last) * 100 : 0;
  const volPct = volPerPrintPct(series);

  const prices = (input.poolPricesUsd ?? []).filter((p) => p > 0);
  let dislocationPct = 0;
  if (prices.length >= 2) {
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    if (lo > 0) dislocationPct = (hi / lo - 1) * 100;
  }

  /**
   * Confidence = agreement, not age. Sample count sets the ceiling; the
   * classification's decisiveness (how far past the threshold we are) and
   * cross-pool agreement scale it. An ambiguous tape with 200 prints is NOT
   * a confident regime.
   */
  const sampleCeiling = Math.min(1, (series.length - MIN_PRINTS + 1) / 60 + 0.5);
  const sigma = Math.max(0.05, volPct);
  const poolAgreement = prices.length >= 2 ? clamp01(1 - dislocationPct / DISLOCATION_PCT) : 0.5;

  const decisive = (distance: number, threshold: number) =>
    clamp01(distance / Math.max(1e-9, threshold) - 1);

  // Dislocation wins: when pools disagree, directional signals are noise.
  if (dislocationPct >= DISLOCATION_PCT) {
    const strength = decisive(dislocationPct, DISLOCATION_PCT);
    return {
      regime: "dislocation",
      trendSepPct,
      volPct,
      dislocationPct,
      confidence: clamp01(sampleCeiling * (0.6 + 0.4 * strength)),
      explain: [
        `pools disagree ${dislocationPct.toFixed(2)}% — cross-book arb territory`,
        `trend ${trendSepPct >= 0 ? "+" : ""}${trendSepPct.toFixed(2)}% · vol ${volPct.toFixed(2)}%/print`,
      ],
    };
  }
  if (volPct >= HIGH_VOL_PCT) {
    const strength = decisive(volPct, HIGH_VOL_PCT);
    return {
      regime: "high_vol",
      trendSepPct,
      volPct,
      dislocationPct,
      confidence: clamp01(sampleCeiling * (0.6 + 0.4 * strength) * (0.7 + 0.3 * poolAgreement)),
      explain: [`vol ${volPct.toFixed(2)}%/print ≥ ${HIGH_VOL_PCT}% — size down, arb up`],
    };
  }
  if (Math.abs(trendSepPct) >= TREND_SIGMA * sigma && Math.abs(trendSepPct) >= 0.08) {
    const up = trendSepPct > 0;
    const strength = decisive(Math.abs(trendSepPct), TREND_SIGMA * sigma);
    return {
      regime: up ? "trend_up" : "trend_down",
      trendSepPct,
      volPct,
      dislocationPct,
      confidence: clamp01(sampleCeiling * (0.55 + 0.45 * strength) * (0.7 + 0.3 * poolAgreement)),
      explain: [
        `EMA${EMA_FAST} ${up ? "above" : "below"} EMA${EMA_SLOW} by ${Math.abs(trendSepPct).toFixed(2)}% (${(Math.abs(trendSepPct) / sigma).toFixed(1)}σ of print vol)`,
      ],
    };
  }
  if (volPct <= LOW_VOL_PCT) {
    return {
      regime: "low_vol",
      trendSepPct,
      volPct,
      dislocationPct,
      confidence: clamp01(sampleCeiling * 0.8 * (0.7 + 0.3 * poolAgreement)),
      explain: [`vol ${volPct.toFixed(2)}%/print ≤ ${LOW_VOL_PCT}% — tight spreads viable`],
    };
  }
  // Range: confidence is the DISTANCE FROM a trend — a tape hugging the
  // trend threshold is not confidently a range.
  const rangeHeadroom = clamp01(1 - Math.abs(trendSepPct) / (TREND_SIGMA * sigma));
  return {
    regime: "range",
    trendSepPct,
    volPct,
    dislocationPct,
    confidence: clamp01(sampleCeiling * (0.5 + 0.5 * rangeHeadroom) * (0.7 + 0.3 * poolAgreement)),
    explain: [
      `no trend (${Math.abs(trendSepPct).toFixed(2)}% < ${(TREND_SIGMA * sigma).toFixed(2)}% band) — mean reversion / grid territory`,
    ],
  };
}

/**
 * Strategy multiplier per regime. 1 = neutral, >1 = favored, <1 = damped,
 * 0 = vetoed. Applied to strategy confidence / candidate ranking — never to
 * exits (risk actions always fire).
 */
export function regimeWeight(regime: MarketRegime, source: string): number {
  switch (regime) {
    case "trend_up":
      if (source === "signal") return 1.2;
      if (source === "meanrev") return 0.5;
      if (source === "grid") return 0.6;
      if (source === "dca") return 0.8;
      if (source === "growth") return 1.1;
      return 1;
    case "trend_down":
      if (source === "signal") return 0.3; // buys basically off
      if (source === "meanrev") return 0.4; // needs reversal confirmation
      if (source === "grid") return 0.5;
      if (source === "dca") return 0; // never average into a downtrend
      if (source === "spread") return 1.1;
      if (source === "growth") return 0.9;
      return 1;
    case "range":
      if (source === "meanrev") return 1.25;
      if (source === "grid") return 1.25;
      if (source === "signal") return 0.7;
      if (source === "spread") return 1.1;
      return 1;
    case "high_vol":
      if (source === "spread") return 1.25;
      if (source === "dca") return 0.5;
      if (source === "grid") return 0.8;
      if (source === "growth") return 0.7;
      if (source === "volume" || source === "volume-x") return 0.7;
      return 1;
    case "low_vol":
      if (source === "volume" || source === "volume-x") return 1.1;
      if (source === "dca") return 1.1;
      if (source === "spread") return 0.9;
      return 1;
    case "dislocation":
      if (source === "spread") return 1.3;
      if (source === "signal") return 0.4;
      if (source === "meanrev") return 0.5;
      if (source === "grid") return 0.5;
      if (source === "dca") return 0.5;
      return 0.9;
    default:
      return 1;
  }
}
