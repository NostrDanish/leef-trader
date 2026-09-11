import { fetchJson } from "@/lib/fetchJson";

/** A liquidity position on the Alcor AMM, from /api/v2/account/:name/positions. */
export type AmmPosition = {
  /** Position id (uint64). */
  id: number;
  /** Pool id. */
  poolId: number;
  owner: string;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  /** Unclaimed fees, asset strings ("12.34 WAX"). */
  feesA: string;
  feesB: string;
  closed: boolean;
};

type RawPosition = {
  id?: number;
  pool?: number;
  owner?: string;
  liquidity?: number | string;
  tickLower?: number;
  tickUpper?: number;
  feesA?: string;
  feesB?: string;
  closed?: boolean;
};

export async function fetchPositions(account: string): Promise<AmmPosition[]> {
  const raw = await fetchJson(
    `https://wax.alcor.exchange/api/v2/account/${encodeURIComponent(account)}/positions`,
    { timeoutMs: 10_000 },
  );
  if (!Array.isArray(raw)) return [];
  const out: AmmPosition[] = [];
  for (const r of raw as RawPosition[]) {
    if (!r || typeof r !== "object") continue;
    const id = Number(r.id);
    const poolId = Number(r.pool);
    const liq = BigInt(Math.trunc(Number(r.liquidity ?? 0)));
    if (!Number.isFinite(id) || !Number.isFinite(poolId) || liq <= 0n || r.closed) continue;
    out.push({
      id,
      poolId,
      owner: String(r.owner ?? account),
      liquidity: liq,
      tickLower: Math.trunc(Number(r.tickLower ?? 0)),
      tickUpper: Math.trunc(Number(r.tickUpper ?? 0)),
      feesA: String(r.feesA ?? ""),
      feesB: String(r.feesB ?? ""),
      closed: Boolean(r.closed),
    });
  }
  return out;
}
