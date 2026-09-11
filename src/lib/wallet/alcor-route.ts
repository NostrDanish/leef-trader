import { fetchJson } from "@/lib/fetchJson";

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
}): Promise<AlcorRouteQuote> {
  const params = new URLSearchParams({
    trade_type: "EXACT_INPUT",
    input: opts.tokenInId,
    output: opts.tokenOutId,
    amount: String(opts.amount),
    slippage: String(Math.max(0.05, opts.slippagePct)),
    receiver: opts.receiver,
    maxHops: String(opts.maxHops ?? 10),
    v2: "true",
  });
  const raw = await fetchJson(`${ROUTER}?${params.toString()}`, { timeoutMs: 12_000 });
  if (!isQuote(raw)) throw new Error("Alcor router returned no usable route");
  return raw;
}

export function parseAssetAmount(asset: string): number {
  const n = Number(String(asset).trim().split(/\s+/)[0]);
  return Number.isFinite(n) ? n : 0;
}
