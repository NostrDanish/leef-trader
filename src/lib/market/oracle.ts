/**
 * Live WAX/USD price (contract: CORE implements, UI consumes).
 * Primary: Delphi on-chain oracle (delphioracle/waxpusd datapoints, seconds-
 * fresh, manipulation-resistant) via the health-scored RPC pool — median of
 * value/1e4 across reporters. Fallback: Alcor's token endpoint
 * (safe_usd_price ?? usd_price). Throws only when BOTH are unreachable; the
 * UI renders an honest unavailable state.
 */
import { fetchJson } from "@/lib/fetchJson";
import { rpcPost } from "@/lib/wallet/chain";

export interface WaxUsdPrice {
  usd: number;
  fetchedAt: number;
  source: "delphioracle" | "alcor";
}

const ALCOR_WAX_TOKEN = "https://wax.alcor.exchange/api/v2/tokens/wax-eosio.token";

async function delphiWaxUsd(): Promise<number> {
  const raw = (await rpcPost(
    "/v1/chain/get_table_rows",
    { json: true, code: "delphioracle", scope: "waxpusd", table: "datapoints", limit: 25 },
    8_000,
    "low",
  )) as { rows?: { value?: unknown }[] };
  const values = (Array.isArray(raw?.rows) ? raw.rows : [])
    .map((r) => Number(r?.value) / 1e4)
    .filter((n) => n > 0 && Number.isFinite(n))
    .sort((a, b) => a - b);
  if (values.length === 0) throw new Error("delphioracle returned no datapoints");
  return values[Math.floor(values.length / 2)]!;
}

export async function fetchWaxUsd(): Promise<WaxUsdPrice> {
  try {
    const usd = await delphiWaxUsd();
    return { usd, fetchedAt: Date.now(), source: "delphioracle" };
  } catch {
    /* fall through to Alcor */
  }
  const raw = (await fetchJson(ALCOR_WAX_TOKEN, {
    timeoutMs: 6_000,
    priority: "low",
    context: { operation: "Alcor WAX token price", endpoint: ALCOR_WAX_TOKEN },
  })) as { safe_usd_price?: unknown; usd_price?: unknown };
  const usd = Number(raw?.safe_usd_price ?? raw?.usd_price);
  if (!(usd > 0)) throw new Error("Alcor returned no WAX/USD price");
  return { usd, fetchedAt: Date.now(), source: "alcor" };
}
