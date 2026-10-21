/**
 * Real LEEF order-book depth (contract: CORE implements, UI consumes).
 * Primary: Alcor spot market 119 orderbook — RAW INTS scaled by token
 * precision (price: WAX base, 8 dp; quantity: LEEF quote, 4 dp — verified
 * against the market 119 detail payload 2026-10-20).
 * Fallback: Alcor swap pool 217 liquidityChartSeries mapped to pseudo-depth
 * (AMM liquidity histogram, NOT a limit-order book — source "alcor-amm").
 */
import { fetchJson } from "@/lib/fetchJson";

export interface DepthLevel {
  /** WAX per 1 LEEF. */
  price: number;
  /** LEEF quantity at this level. */
  quantity: number;
  /** WAX value of the level (price × quantity). */
  total: number;
}

export interface DepthResult {
  bids: DepthLevel[];
  asks: DepthLevel[];
  mid: number | null;
  source: "alcor-spot" | "alcor-amm";
  /**
   * What `quantity` measures: "LEEF" for the real order book, "liquidity"
   * for the AMM fallback (raw AMM liquidity L — NOT a LEEF amount; the UI
   * must label it accordingly).
   */
  unit: "LEEF" | "liquidity";
  fetchedAt: number;
}

const SPOT_ORDERBOOK = "https://wax.alcor.exchange/api/markets/119/orderbook";
const AMM_LIQUIDITY =
  "https://wax.alcor.exchange/api/v2/swap/pools/217/liquidityChartSeries?inverted=false";
const AMM_POOL = "https://wax.alcor.exchange/api/v2/swap/pools/217";

const PRICE_SCALE = 1e8; // WAX precision
const QTY_SCALE = 1e4; // LEEF precision

function parseSide(raw: unknown, isBid: boolean): DepthLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: DepthLevel[] = [];
  for (const lvl of raw) {
    // Live shape: [priceInt, [priceInt, qtyInt, totalInt]]
    const head = Array.isArray(lvl) ? lvl[0] : null;
    const qtyInt = Array.isArray(lvl) && Array.isArray(lvl[1]) ? lvl[1][1] : null;
    const price = Number(head) / PRICE_SCALE;
    const quantity = Number(qtyInt) / QTY_SCALE;
    if (!(price > 0) || !(quantity > 0)) continue;
    out.push({ price, quantity, total: price * quantity });
  }
  out.sort((a, b) => (isBid ? b.price - a.price : a.price - b.price));
  return out;
}

/** Pool 217 spot (WAX per LEEF) from the live reserve detail payload. */
function poolSpotWaxPerLeef(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as {
    tokenA?: { symbol?: unknown; quantity?: unknown };
    tokenB?: { symbol?: unknown; quantity?: unknown };
  };
  const toks = [p.tokenA, p.tokenB];
  const wax = toks.find((t) => String(t?.symbol ?? "").toUpperCase() === "WAX");
  const leef = toks.find((t) => String(t?.symbol ?? "").toUpperCase() === "LEEF");
  const waxQty = Number(wax?.quantity);
  const leefQty = Number(leef?.quantity);
  return waxQty > 0 && leefQty > 0 ? waxQty / leefQty : null;
}

/**
 * AMM histogram {x: LEEF per WAX, y: liquidity} → pseudo-depth in WAX/LEEF.
 * `mid` anchors to the pool's CURRENT spot when available — the median of
 * the liquidity series is a distribution midpoint, not a price — with the
 * median kept only as a last resort when the spot read failed.
 */
function parseAmm(
  raw: unknown,
  spotWaxPerLeef: number | null,
): { bids: DepthLevel[]; asks: DepthLevel[]; mid: number | null } {
  if (!Array.isArray(raw)) return { bids: [], asks: [], mid: null };
  const pts: { price: number; liquidity: number }[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const x = Number((p as { x?: unknown }).x);
    const y = Number((p as { y?: unknown }).y);
    if (x > 0 && Number.isFinite(y) && y > 0) pts.push({ price: 1 / x, liquidity: y });
  }
  if (pts.length === 0) return { bids: [], asks: [], mid: null };
  pts.sort((a, b) => a.price - b.price);
  const mid = spotWaxPerLeef ?? pts[Math.floor(pts.length / 2)]!.price;
  const toLevel = (p: { price: number; liquidity: number }): DepthLevel => ({
    price: p.price,
    quantity: p.liquidity,
    total: p.price * p.liquidity,
  });
  return {
    bids: pts.filter((p) => p.price < mid).map(toLevel).sort((a, b) => b.price - a.price),
    asks: pts.filter((p) => p.price >= mid).map(toLevel),
    mid,
  };
}

export async function fetchLeefDepth(): Promise<DepthResult> {
  try {
    const raw = (await fetchJson(SPOT_ORDERBOOK, {
      timeoutMs: 8_000,
      priority: "low",
      context: { operation: "Alcor spot orderbook", endpoint: SPOT_ORDERBOOK },
    })) as { bids?: unknown; asks?: unknown };
    const bids = parseSide(raw?.bids, true);
    const asks = parseSide(raw?.asks, false);
    if (bids.length > 0 || asks.length > 0) {
      const bestBid = bids[0]?.price;
      const bestAsk = asks[0]?.price;
      const mid =
        bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk ?? null);
      return { bids, asks, mid, source: "alcor-spot", unit: "LEEF", fetchedAt: Date.now() };
    }
  } catch {
    /* fall through to the AMM histogram */
  }
  const [raw, pool] = await Promise.all([
    fetchJson(AMM_LIQUIDITY, {
      timeoutMs: 8_000,
      priority: "low",
      context: { operation: "Alcor AMM liquidity series", endpoint: AMM_LIQUIDITY },
    }),
    // Spot anchor for the pseudo-depth mid; a failed read degrades to the
    // median anchor, never to a thrown depth panel.
    fetchJson(AMM_POOL, {
      timeoutMs: 8_000,
      priority: "low",
      context: { operation: "Alcor AMM pool detail", endpoint: AMM_POOL },
    }).catch(() => null),
  ]);
  const { bids, asks, mid } = parseAmm(raw, poolSpotWaxPerLeef(pool));
  return { bids, asks, mid, source: "alcor-amm", unit: "liquidity", fetchedAt: Date.now() };
}
