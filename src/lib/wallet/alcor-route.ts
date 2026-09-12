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
}): Promise<AlcorRouteQuote> {
  if (!(opts.amount > 0) || !Number.isFinite(opts.amount)) {
    throw new Error("Invalid amount — nothing to quote");
  }
  const decimals = decimalsForAlcorId(opts.tokenInId);
  const amount = formatAmountParam(opts.amount, decimals);
  if (Number(amount) <= 0) {
    throw new Error(`Invalid amount — ${opts.amount} rounds to 0 at ${decimals} decimals`);
  }
  const params = new URLSearchParams({
    trade_type: "EXACT_INPUT",
    input: opts.tokenInId,
    output: opts.tokenOutId,
    amount,
    slippage: String(Math.max(0.05, opts.slippagePct)),
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
        slippage: String(Math.max(0.05, opts.slippagePct)),
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
