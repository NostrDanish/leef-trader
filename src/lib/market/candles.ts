/**
 * Real LEEF/WAX OHLCV candles (contract: CORE implements, UI consumes).
 * ONE price convention out of this module: WAX per 1 LEEF, matching the
 * rest of the terminal (spot market 119, depth, charts at precision 8).
 * Primary: Alcor swap v2 pool 217 candles — live-verified to be priced
 * LEEF-per-WAX (close ≈ "29873.8"), so they are INVERTED here (1/x, with
 * high/low swapped after inversion).
 * Fallback: Alcor spot market 119 charts (already WAX-per-LEEF, ≈3.5e-5).
 * Empty array on failure — the UI shows an honest empty state, never
 * fabricated candles.
 */
import { fetchJson } from "@/lib/fetchJson";

export interface Candle {
  /** ms epoch UTC. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Minutes (TradingView-style Alcor resolutions). */
export type CandleResolution = 1 | 5 | 15 | 30 | 60 | 240;

export interface CandleResult {
  candles: Candle[];
  source: "alcor-swap" | "alcor-spot";
  fetchedAt: number;
}

const SWAP_CANDLES = "https://wax.alcor.exchange/api/v2/swap/pools/217/candles";
const SPOT_CHARTS = "https://wax.alcor.exchange/api/markets/119/charts";

function num(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? n : NaN;
}

function parseCandles(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) return [];
  const out: Candle[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const c: Candle = {
      time: num(o.time),
      open: num(o.open),
      high: num(o.high),
      low: num(o.low),
      close: num(o.close),
      volume: num(o.volume) || 0,
    };
    if (Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.close)) {
      out.push(c);
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * Swap-pool candles are priced LEEF-per-WAX; the module convention is
 * WAX-per-LEEF. Invert o/h/l/c as 1/x — and SWAP high/low, because 1/x
 * reverses the ordering (the highest LEEF/WAX print is the lowest
 * WAX/LEEF one). Non-positive prices are dropped, never inverted.
 */
function invertToWaxPerLeef(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    if (!(c.open > 0) || !(c.high > 0) || !(c.low > 0) || !(c.close > 0)) continue;
    out.push({
      time: c.time,
      open: 1 / c.open,
      high: 1 / c.low,
      low: 1 / c.high,
      close: 1 / c.close,
      volume: c.volume,
    });
  }
  return out;
}

export async function fetchLeefCandles(
  resolution: CandleResolution,
  fromMs: number,
  toMs: number,
): Promise<CandleResult> {
  try {
    const raw = await fetchJson(
      `${SWAP_CANDLES}?resolution=${resolution}&from=${Math.round(fromMs)}&to=${Math.round(toMs)}`,
      {
        timeoutMs: 8_000,
        priority: "low",
        context: { operation: "Alcor swap candles", endpoint: SWAP_CANDLES, params: { resolution } },
      },
    );
    const candles = invertToWaxPerLeef(parseCandles(raw));
    if (candles.length > 0) return { candles, source: "alcor-swap", fetchedAt: Date.now() };
  } catch {
    /* fall through to the spot charts */
  }
  const raw = await fetchJson(`${SPOT_CHARTS}?resolution=${resolution}`, {
    timeoutMs: 8_000,
    priority: "low",
    context: { operation: "Alcor spot charts", endpoint: SPOT_CHARTS, params: { resolution } },
  });
  const candles = parseCandles(raw).filter((c) => c.time >= fromMs && c.time <= toMs);
  return { candles, source: "alcor-spot", fetchedAt: Date.now() };
}
