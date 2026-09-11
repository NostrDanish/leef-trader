import { backedPools } from "./amm";
import type { Candle, IndicatorId, TickParams } from "./indicators";
import { usdPerMillion } from "./route-loss";
import type { LeefPool, LeefSnapshot, LiveTrade } from "./types";

export type LivePrint = {
  t: number;
  px: number;
  pairPx: number;
  poolId: number;
  pair: string;
  side: "buy" | "sell";
  src: "book" | "fill";
  loss: number | null;
  role: "best-buy" | "best-sell" | null;
};

export const DEFAULT_ENGINES: Record<IndicatorId, boolean> = {
  bb: true,
  macd: true,
  rsi: true,
  ema: true,
  sma: false,
  stoch: false,
  vwap: true,
};

export const DEFAULT_TICK_PARAMS: TickParams & {
  speedMs: number;
  vol: number;
  bars: number;
  barSec: number;
} = {
  speedMs: 700,
  vol: 1,
  bars: 160,
  barSec: 30,
  smaPeriod: 20,
  emaPeriod: 21,
  bbPeriod: 20,
  bbStd: 2,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  rsiPeriod: 14,
  stochK: 14,
  stochD: 3,
  sensitivity: 1,
  engines: { ...DEFAULT_ENGINES },
};

export type TickKnobs = typeof DEFAULT_TICK_PARAMS;

export const TICK_PRESETS: { id: string; label: string; patch: Partial<TickKnobs> }[] = [
  {
    id: "scalp",
    label: "Scalp",
    patch: {
      speedMs: 350,
      vol: 1.35,
      bars: 90,
      barSec: 30,
      bbPeriod: 12,
      bbStd: 1.6,
      macdFast: 6,
      macdSlow: 13,
      macdSignal: 5,
      rsiPeriod: 7,
      emaPeriod: 9,
      smaPeriod: 12,
      stochK: 9,
      sensitivity: 1.25,
      engines: { bb: true, macd: true, rsi: true, ema: true, sma: false, stoch: true, vwap: false },
    },
  },
  {
    id: "swing",
    label: "Swing",
    patch: {
      speedMs: 900,
      vol: 0.9,
      bars: 180,
      barSec: 30,
      bbPeriod: 20,
      bbStd: 2,
      macdFast: 12,
      macdSlow: 26,
      macdSignal: 9,
      rsiPeriod: 14,
      emaPeriod: 21,
      smaPeriod: 20,
      sensitivity: 1,
      engines: { ...DEFAULT_ENGINES },
    },
  },
  {
    id: "mean",
    label: "Mean-revert",
    patch: {
      speedMs: 650,
      vol: 0.85,
      bars: 140,
      barSec: 30,
      bbPeriod: 18,
      bbStd: 2.1,
      rsiPeriod: 10,
      stochK: 12,
      sensitivity: 1.4,
      engines: { bb: true, macd: false, rsi: true, ema: false, sma: true, stoch: true, vwap: true },
    },
  },
  {
    id: "trend",
    label: "Trend",
    patch: {
      speedMs: 800,
      vol: 1.1,
      bars: 200,
      barSec: 60,
      emaPeriod: 34,
      smaPeriod: 50,
      macdFast: 12,
      macdSlow: 26,
      sensitivity: 0.85,
      engines: { bb: false, macd: true, rsi: false, ema: true, sma: true, stoch: false, vwap: true },
    },
  },
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function displaySpot(pool: LeefPool, snap?: Pick<LeefSnapshot, "waxUsd" | "leefUsd">): number {
  if (snap) return usdPerMillion(pool, snap.waxUsd, snap.leefUsd);
  const per = pool.waxPerLeef ?? pool.pairPerLeef;
  return per * 1_000_000;
}

export function displayUnit(pool: LeefPool): string {
  return "USD / 1M";
}

export function pickTickPool(pools: LeefPool[], id: number | null): LeefPool | undefined {
  const ok = backedPools(pools);
  if (id != null) {
    const hit = ok.find((p) => p.id === id);
    if (hit) return hit;
  }
  return [...ok].sort((a, b) => b.tvlUsd - a.tvlUsd)[0];
}

function hhmm(t: number, withSec = false): string {
  const d = new Date(t);
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  if (!withSec) return `${h}:${m}`;
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function clampPrice(n: number, spot: number): number {
  const floor = Math.max(spot * 0.35, 1e-9);
  const ceil = spot * 2.8;
  return Math.min(ceil, Math.max(floor, n));
}

/** Seeded OHLC path pinned to the live USD/1M print, with 24h change as drift. */
export function buildHistory(
  pool: LeefPool,
  trades: LiveTrade[],
  bars: number,
  barSec: number,
  endMs: number,
  volMult: number,
  snap: Pick<LeefSnapshot, "waxUsd" | "leefUsd">,
): Candle[] {
  const n = Math.max(40, Math.min(300, Math.floor(bars)));
  const step = Math.max(15, Math.floor(barSec)) * 1000;
  const withSec = barSec < 60;
  const end = Math.floor(endMs / step) * step;
  const spot = displaySpot(pool, snap);
  const chg = Number.isFinite(pool.change24) ? pool.change24 / 100 : 0;
  const start = spot / Math.max(0.4, 1 + chg);
  const rng = mulberry32(pool.id * 9973 + Math.floor(end / step));
  const sigma = Math.max(0.0018, Math.abs(chg) * 0.12 + 0.004) * volMult;

  const prints = trades
    .filter((t) => t.poolId === pool.id && t.usdVolume > 0)
    .map((t) => ({
      t: t.timestamp,
      px: displaySpot(pool, snap) * (1 + (rng() - 0.5) * 0.01),
      vol: Math.max(t.usdVolume, 0.01),
    }));

  const out: Candle[] = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const t = end - (n - 1 - i) * step;
    const prog = n === 1 ? 1 : i / (n - 1);
    const target = start + (spot - start) * prog;
    const jump = rng() < 0.04 ? (rng() - 0.5) * sigma * 6 * px : 0;
    const shock = (rng() - 0.5) * 2 * sigma * px;
    const revert = (target - px) * 0.18;
    px = clampPrice(px + revert + shock + jump, spot);
    if (i === n - 1) px = spot;
    const wick = (0.15 + rng() * 0.55) * sigma * px;
    const open = i === 0 ? start : out[i - 1]!.c;
    let high = Math.max(open, px) + wick * rng();
    let low = Math.min(open, px) - wick * rng();
    let vol = (0.4 + rng() * 1.6) * (pool.volume24Usd / Math.max(n, 1) + 0.05);
    for (const p of prints) {
      if (p.t >= t && p.t < t + step) {
        high = Math.max(high, p.px);
        low = Math.min(low, p.px);
        vol += p.vol;
      }
    }
    low = Math.max(low, px * 0.5);
    high = Math.max(high, px);
    out.push({
      t,
      o: open,
      h: high,
      l: low,
      c: px,
      v: vol,
      label: hhmm(t, withSec),
    });
  }
  return out;
}

/** Pin the path to a real 30s book print — no synthetic drift. */
export function applyBookPrint(
  candles: Candle[],
  spot: number,
  barSec: number,
  now: number,
  volume: number,
): { candles: Candle[]; print: LivePrint } {
  const step = Math.max(15, barSec) * 1000;
  const withSec = barSec < 60;
  const bucket = Math.floor(now / step) * step;
  const last = candles[candles.length - 1];
  const prev = last?.c ?? spot;
  const side: "buy" | "sell" = spot >= prev ? "buy" : "sell";
  const print: LivePrint = {
    t: now,
    px: spot,
    pairPx: spot,
    poolId: 0,
    pair: "",
    side,
    src: "book",
    loss: null,
    role: null,
  };

  if (!last) {
    const c: Candle = {
      t: bucket,
      o: spot,
      h: spot,
      l: spot,
      c: spot,
      v: volume,
      label: hhmm(bucket, withSec),
    };
    return { candles: [c], print };
  }
  if (bucket <= last.t) {
    const updated: Candle = {
      ...last,
      h: Math.max(last.h, spot),
      l: Math.min(last.l, spot),
      c: spot,
      v: last.v + volume,
    };
    return { candles: [...candles.slice(0, -1), updated], print };
  }
  const fresh: Candle = {
    t: bucket,
    o: last.c,
    h: Math.max(last.c, spot),
    l: Math.min(last.c, spot),
    c: spot,
    v: volume,
    label: hhmm(bucket, withSec),
  };
  const nextBars = [...candles, fresh];
  return {
    candles: nextBars.length > 320 ? nextBars.slice(nextBars.length - 320) : nextBars,
    print,
  };
}
