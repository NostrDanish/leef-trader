export type Candle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  label: string;
};

export type IndicatorId = "bb" | "macd" | "rsi" | "ema" | "sma" | "stoch" | "vwap";

export const INDICATORS: {
  id: IndicatorId;
  label: string;
  hint: string;
}[] = [
  { id: "bb", label: "Bollinger", hint: "Mean-revert when price tags the bands" },
  { id: "macd", label: "MACD", hint: "Momentum from fast vs slow EMA" },
  { id: "rsi", label: "RSI", hint: "Wilder oscillator, 30/70 extremes" },
  { id: "ema", label: "EMA", hint: "Trend — price vs exponential average" },
  { id: "sma", label: "SMA", hint: "Slow baseline average" },
  { id: "stoch", label: "Stochastic", hint: "%K / %D cross in the range" },
  { id: "vwap", label: "VWAP", hint: "Session volume-weighted fair value" },
];

export type TickParams = {
  smaPeriod: number;
  emaPeriod: number;
  bbPeriod: number;
  bbStd: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  rsiPeriod: number;
  stochK: number;
  stochD: number;
  sensitivity: number;
  engines: Record<IndicatorId, boolean>;
};

export type ChartPoint = Candle & {
  sma: number | null;
  ema: number | null;
  bbMid: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  pctB: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  rsi: number | null;
  stochK: number | null;
  stochD: number | null;
  vwap: number | null;
};

export type EngineReading = {
  id: IndicatorId;
  score: number;
  label: string;
  detail: string;
};

export type SignalSnap = {
  score: number;
  bias: "buy" | "sell" | "hold";
  confidence: number;
  readings: EngineReading[];
};

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function sampleStd(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (n - 1));
}

function smaArr(values: number[], period: number): (number | null)[] {
  const p = Math.max(1, Math.floor(period));
  const out: (number | null)[] = Array(values.length).fill(null);
  let run = 0;
  for (let i = 0; i < values.length; i++) {
    run += values[i]!;
    if (i >= p) run -= values[i - p]!;
    if (i >= p - 1) out[i] = run / p;
  }
  return out;
}

function emaArr(values: number[], period: number): (number | null)[] {
  const p = Math.max(1, Math.floor(period));
  const k = 2 / (p + 1);
  const out: (number | null)[] = Array(values.length).fill(null);
  if (values.length === 0) return out;
  let prev: number | null = null;
  let seed = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (i < p) {
      seed += v;
      if (i === p - 1) {
        prev = seed / p;
        out[i] = prev;
      }
      continue;
    }
    prev = v * k + (prev ?? v) * (1 - k);
    out[i] = prev;
  }
  if (values.length < p) {
    out[values.length - 1] = values[values.length - 1] ?? null;
  }
  return out;
}

function rsiArr(values: number[], period: number): (number | null)[] {
  const p = Math.max(2, Math.floor(period));
  const out: (number | null)[] = Array(values.length).fill(null);
  if (values.length <= p) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / p;
  let avgLoss = loss / p;
  out[p] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = p + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (p - 1) + g) / p;
    avgLoss = (avgLoss * (p - 1) + l) / p;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function stochArr(
  highs: number[],
  lows: number[],
  closes: number[],
  kPeriod: number,
  dPeriod: number,
): { k: (number | null)[]; d: (number | null)[] } {
  const kp = Math.max(2, Math.floor(kPeriod));
  const dp = Math.max(1, Math.floor(dPeriod));
  const k: (number | null)[] = Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (i < kp - 1) continue;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - kp + 1; j <= i; j++) {
      hi = Math.max(hi, highs[j]!);
      lo = Math.min(lo, lows[j]!);
    }
    const span = hi - lo;
    k[i] = span <= 0 ? 50 : ((closes[i]! - lo) / span) * 100;
  }
  const kNums = k.map((v) => (v == null ? NaN : v));
  const dRaw = smaArr(
    kNums.map((v) => (Number.isFinite(v) ? v : 0)),
    dp,
  );
  const d = dRaw.map((v, i) => (k[i] == null ? null : v));
  return { k, d };
}

function vwapArr(candles: Candle[]): (number | null)[] {
  const out: (number | null)[] = Array(candles.length).fill(null);
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const typical = (c.h + c.l + c.c) / 3;
    const v = Math.max(c.v, 0);
    pv += typical * v;
    vol += v;
    out[i] = vol > 0 ? pv / vol : typical;
  }
  return out;
}

function clamp(n: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, n));
}

export function decorate(candles: Candle[], params: TickParams): ChartPoint[] {
  const closes = candles.map((c) => c.c);
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const sma = smaArr(closes, params.smaPeriod);
  const ema = emaArr(closes, params.emaPeriod);
  const bbMid = smaArr(closes, params.bbPeriod);
  const fast = Math.min(params.macdFast, params.macdSlow - 1);
  const slow = Math.max(params.macdSlow, fast + 2);
  const emaFast = emaArr(closes, fast);
  const emaSlow = emaArr(closes, slow);
  const macdLine = closes.map((_, i) => {
    const a = emaFast[i];
    const b = emaSlow[i];
    if (a == null || b == null) return null;
    return a - b;
  });
  const macdNums = macdLine.map((v) => v ?? 0);
  const firstValid = macdLine.findIndex((v) => v != null);
  const signalRaw = emaArr(
    macdNums.slice(Math.max(0, firstValid)),
    params.macdSignal,
  );
  const macdSignal: (number | null)[] = Array(closes.length).fill(null);
  for (let i = 0; i < signalRaw.length; i++) {
    const idx = i + Math.max(0, firstValid);
    if (idx < macdSignal.length && macdLine[idx] != null) macdSignal[idx] = signalRaw[i] ?? null;
  }
  const rsi = rsiArr(closes, params.rsiPeriod);
  const stoch = stochArr(highs, lows, closes, params.stochK, params.stochD);
  const vwap = vwapArr(candles);

  return candles.map((c, i) => {
    const mid = bbMid[i];
    let upper: number | null = null;
    let lower: number | null = null;
    let pctB: number | null = null;
    if (mid != null && i >= params.bbPeriod - 1) {
      const window = closes.slice(i - params.bbPeriod + 1, i + 1);
      const sd = sampleStd(window) * params.bbStd;
      upper = mid + sd;
      lower = mid - sd;
      const span = upper - lower;
      pctB = span > 0 ? (c.c - lower) / span : 0.5;
    }
    const macd = macdLine[i];
    const sig = macdSignal[i];
    return {
      ...c,
      sma: sma[i] ?? null,
      ema: ema[i] ?? null,
      bbMid: mid ?? null,
      bbUpper: upper,
      bbLower: lower,
      pctB,
      macd,
      macdSignal: sig,
      macdHist: macd != null && sig != null ? macd - sig : null,
      rsi: rsi[i] ?? null,
      stochK: stoch.k[i] ?? null,
      stochD: stoch.d[i] ?? null,
      vwap: vwap[i] ?? null,
    };
  });
}

function scoreReading(id: IndicatorId, p: ChartPoint, prev: ChartPoint | null): EngineReading {
  switch (id) {
    case "bb": {
      const pct = p.pctB;
      if (pct == null) return { id, score: 0, label: "—", detail: "Warming up" };
      const score = clamp((0.5 - pct) * 2, -1, 1);
      const label = pct < 0.05 ? "Lower band" : pct > 0.95 ? "Upper band" : "Inside";
      return { id, score, label, detail: `%B ${pct.toFixed(2)}` };
    }
    case "macd": {
      const h = p.macdHist;
      const m = p.macd;
      if (h == null || m == null) return { id, score: 0, label: "—", detail: "Warming up" };
      const scale = Math.max(Math.abs(p.c) * 0.004, 1e-6);
      const score = clamp(h / scale, -1, 1);
      const prevH = prev?.macdHist;
      const cross =
        prevH != null && prevH <= 0 && h > 0
          ? "Bull cross"
          : prevH != null && prevH >= 0 && h < 0
            ? "Bear cross"
            : h > 0
              ? "Positive"
              : "Negative";
      return { id, score, label: cross, detail: `hist ${h.toFixed(3)}` };
    }
    case "rsi": {
      const r = p.rsi;
      if (r == null) return { id, score: 0, label: "—", detail: "Warming up" };
      const score = clamp((50 - r) / 30, -1, 1);
      const label = r < 30 ? "Oversold" : r > 70 ? "Overbought" : "Neutral";
      return { id, score, label, detail: r.toFixed(1) };
    }
    case "ema": {
      const e = p.ema;
      if (e == null || e === 0) return { id, score: 0, label: "—", detail: "Warming up" };
      const dist = (p.c - e) / e;
      const score = clamp(dist / 0.012, -1, 1);
      return {
        id,
        score,
        label: p.c >= e ? "Above EMA" : "Below EMA",
        detail: `${(dist * 100).toFixed(2)}%`,
      };
    }
    case "sma": {
      const s = p.sma;
      if (s == null || s === 0) return { id, score: 0, label: "—", detail: "Warming up" };
      const dist = (p.c - s) / s;
      const score = clamp(dist / 0.015, -1, 1);
      return {
        id,
        score,
        label: p.c >= s ? "Above SMA" : "Below SMA",
        detail: `${(dist * 100).toFixed(2)}%`,
      };
    }
    case "stoch": {
      const k = p.stochK;
      const d = p.stochD;
      if (k == null) return { id, score: 0, label: "—", detail: "Warming up" };
      const score = clamp((50 - k) / 30, -1, 1);
      const cross =
        d != null && k > d ? "K>D" : d != null && k < d ? "K<D" : "—";
      const zone = k < 20 ? "Oversold" : k > 80 ? "Overbought" : cross;
      return { id, score, label: zone, detail: `%K ${k.toFixed(0)}` };
    }
    case "vwap": {
      const v = p.vwap;
      if (v == null || v === 0) return { id, score: 0, label: "—", detail: "Warming up" };
      const dist = (p.c - v) / v;
      const score = clamp(-dist / 0.01, -1, 1);
      return {
        id,
        score,
        label: p.c >= v ? "Rich vs VWAP" : "Cheap vs VWAP",
        detail: `${(dist * 100).toFixed(2)}%`,
      };
    }
  }
}

export function scoreSignal(points: ChartPoint[], params: TickParams): SignalSnap {
  if (points.length === 0) {
    return { score: 0, bias: "hold", confidence: 0, readings: [] };
  }
  const last = points[points.length - 1]!;
  const prev = points[points.length - 2] ?? null;
  const active = INDICATORS.filter((x) => params.engines[x.id]);
  const readings = active.map((x) => scoreReading(x.id, last, prev));
  if (readings.length === 0) {
    return { score: 0, bias: "hold", confidence: 0, readings: [] };
  }
  const raw = readings.reduce((s, r) => s + (Number.isFinite(r.score) ? r.score : 0), 0) / readings.length;
  const score = clamp(Number.isFinite(raw) ? raw * params.sensitivity : 0, -1, 1);
  const agreement =
    readings.filter((r) => Math.sign(r.score) === Math.sign(score) && Math.abs(r.score) > 0.12)
      .length / readings.length;
  const confidence = clamp(
    (Number.isFinite(score) ? Math.abs(score) : 0) * 0.55 +
      (Number.isFinite(agreement) ? agreement : 0) * 0.45,
    0,
    1,
  );
  const dead = 0.18 / Math.max(params.sensitivity, 0.4);
  const bias: SignalSnap["bias"] =
    score > dead ? "buy" : score < -dead ? "sell" : "hold";
  return { score, bias, confidence, readings };
}
