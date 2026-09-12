import { fetchJson } from "@/lib/fetchJson";
import { formatAmountParam } from "./tokens";

const DECIMALS_BY_ID: Record<string, number> = {
  "wax-eosio.token": 8,
  "leef-leefmaincorp": 4,
  "usdt-usdt.alcor": 4,
  "waxusdc-eth.token": 6,
  "waxusdt-eth.token": 6,
  "parausd-parareserves": 6,
};

function decimalsForAlcorId(id: string): number {
  const known = DECIMALS_BY_ID[id.toLowerCase()];
  if (known != null) return known;
  // Alcor ids are `symbol-contract`. Guess from common WAX precisions.
  if (id.startsWith("wax-")) return 8;
  return 4;
}

/**
 * Alcor's public swap router — the same endpoint alcor-ui uses. It runs the
 * full concentrated-liquidity math (ticks, splits) server-side and returns
 * ready-to-sign transfer memos for the `swap.alcor` contract.
 */
const ROUTER = "https://wax.alcor.exchange/api/v2/swapRouter/getRoute";

export type AlcorSwapLeg = {
  /** Asset string being sent, e.g. "10.00000000 WAX". */
  input: string;
  route: number[];
  output: string;
  percent: number;
  /** swapexactin#<pools>#<receiver>#<minOut SYMBOL@contract>#0 */
  memo: string;
  maxSent: string;
  minReceived: string;
};

export type AlcorRouteQuote = {
  route: number[];
  memo: string;
  swaps: AlcorSwapLeg[];
  input: string;
  output: string;
  minReceived: string;
  maxSent: string;
  priceImpact: string;
};

function isQuote(raw: unknown): raw is AlcorRouteQuote {
  if (!raw || typeof raw !== "object") return false;
  const q = raw as Partial<AlcorRouteQuote>;
  return (
    Array.isArray(q.swaps) &&
    q.swaps.length > 0 &&
    q.swaps.every(
      (s) =>
        s &&
        typeof s === "object" &&
        typeof (s as AlcorSwapLeg).input === "string" &&
        typeof (s as AlcorSwapLeg).memo === "string" &&
        (s as AlcorSwapLeg).memo.startsWith("swapexactin#"),
    ) &&
    typeof q.output === "string"
  );
}

/**
 * Alcor `getRoute` does `new Percent(parseFloat(slippage) * 100, 10000)`.
 * JSBI.BigInt throws unless that product is an exact integer; the outer
 * handler turns the throw into HTTP 500 "Internal error".
 *
 * Live evidence (2026-09-12, wax.alcor.exchange):
 *   slippage=1.1  → 500   because 1.1*100 = 110.00000000000001
 *   slippage=0.55 → 500   because 0.55*100 = 55.00000000000001
 *   slippage=0.6  → 200   because 0.6*100 = 60 exactly
 *
 * Never widen the caller's guard: walk DOWN from the requested percent until
 * `Number(s) * 100` is an integer, floored at 0.05%.
 */
export function formatAlcorSlippageParam(slippagePct: number): string {
  const n = Number(slippagePct);
  if (!Number.isFinite(n) || n <= 0) return "0.05";
  let hundredths = Math.floor(Math.min(50, n) * 100 + 1e-9);
  if (hundredths < 5) hundredths = 5;
  // Never round UP — a wider guard than the caller asked for is not a fix.
  while (hundredths >= 5) {
    const s = (hundredths / 100).toFixed(2);
    // Same predicate Alcor's Percent constructor needs: float*100 is integer.
    if (Number.isInteger(parseFloat(s) * 100)) return s;
    hundredths -= 1;
  }
  return "0.05";
}

export async function fetchAlcorRoute(opts: {
  /** Alcor token id being sold, e.g. "wax-eosio.token". */
  tokenInId: string;
  /** Alcor token id being bought, e.g. "leef-leefmaincorp". */
  tokenOutId: string;
  /** Exact input amount in token units. */
  amount: number;
  slippagePct: number;
  receiver: string;
  maxHops?: number;
  timeoutMs?: number;
  /** Authoritative precision of the input token (from the token catalog).
   *  Guessing wrong precision misformats `amount` and the router rejects. */
  decimalsIn?: number;
}): Promise<AlcorRouteQuote> {
  if (!(opts.amount > 0) || !Number.isFinite(opts.amount)) {
    throw new Error("Invalid amount — nothing to quote");
  }
  const decimals =
    typeof opts.decimalsIn === "number" && Number.isFinite(opts.decimalsIn) && opts.decimalsIn >= 0
      ? Math.min(18, opts.decimalsIn | 0)
      : decimalsForAlcorId(opts.tokenInId);
  const amount = formatAmountParam(opts.amount, decimals);
  if (Number(amount) <= 0) {
    throw new Error(`Invalid amount — ${opts.amount} rounds to 0 at ${decimals} decimals`);
  }
  const slippage = formatAlcorSlippageParam(Math.max(0.05, opts.slippagePct));
  const params = new URLSearchParams({
    trade_type: "EXACT_INPUT",
    input: opts.tokenInId,
    output: opts.tokenOutId,
    amount,
    slippage,
    receiver: opts.receiver,
    maxHops: String(opts.maxHops ?? 10),
    v2: "true",
  });
  const raw = await fetchJson(`${ROUTER}?${params.toString()}`, {
    timeoutMs: opts.timeoutMs ?? 5_000,
    priority: "high",
    context: {
      operation: "Alcor router quote",
      endpoint: ROUTER,
      params: {
        input: opts.tokenInId,
        output: opts.tokenOutId,
        amount,
        slippage,
        receiver: opts.receiver,
        maxHops: String(opts.maxHops ?? 10),
      },
    },
  });
  if (!isQuote(raw)) throw new Error("Alcor router returned no usable route");
  return raw;
}

export function parseAssetAmount(asset: string): number {
  const n = Number(String(asset).trim().split(/\s+/)[0]);
  return Number.isFinite(n) ? n : 0;
}
