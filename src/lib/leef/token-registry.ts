/**
 * Alcor token registry — the venue's own verification data.
 *
 * One bulk fetch of /tokens (≈0.5 MB, every listed token) on the cold path.
 * Each token carries Alcor's own `score` (0–99), `is_scam` and `is_trusted`
 * flags, plus `safe_usd_price` (the venue's scam-aware USD mark).
 *
 * Usage:
 *  - is_scam → hard-excluded from the route graph and the universe. A scam
 *    token must never be routed, priced, or suggested — fail closed.
 *  - score → soft ranking signal (higher = more established).
 *  - safe_usd_price → a venue-computed USD mark we can cross-check against.
 */
import { fetchJson } from "@/lib/fetchJson";

export type AlcorTokenRow = {
  id: string; // "wax-eosio.token"
  symbol: string;
  contract: string;
  decimals: number;
  score: number;
  is_scam: boolean;
  is_trusted: boolean;
  safe_usd_price?: number;
  system_price?: number;
};

type Registry = Map<string, AlcorTokenRow>;

let registry: Registry = new Map();
let fetchedAt = 0;
let inflight: Promise<Registry> | null = null;

const REFRESH_MS = 30 * 60_000; // scores move slowly — half an hour
const ENDPOINT = "https://wax.alcor.exchange/api/v2/tokens";

/** Load (or return cached) the full Alcor token registry. Never throws. */
export async function loadTokenRegistry(force = false): Promise<Registry> {
  if (!force && registry.size > 0 && Date.now() - fetchedAt < REFRESH_MS) return registry;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const raw = (await fetchJson(ENDPOINT, {
        timeoutMs: 20_000,
        priority: "low",
        context: { operation: "Alcor token registry", endpoint: ENDPOINT },
      })) as unknown;
      if (!Array.isArray(raw)) return registry;
      const next: Registry = new Map();
      for (const row of raw) {
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const id = String(r.id ?? "").toLowerCase();
        const symbol = String(r.symbol ?? "").toUpperCase();
        const contract = String(r.contract ?? "").toLowerCase();
        if (!id || !symbol || !contract) continue;
        next.set(id, {
          id,
          symbol,
          contract,
          decimals: Number(r.decimals ?? 4) || 4,
          score: Number(r.score ?? 0) || 0,
          is_scam: r.is_scam === true,
          is_trusted: r.is_trusted === true,
          safe_usd_price: typeof r.safe_usd_price === "number" ? r.safe_usd_price : undefined,
          system_price: typeof r.system_price === "number" ? r.system_price : undefined,
        });
      }
      if (next.size > 0) {
        registry = next;
        fetchedAt = Date.now();
      }
      return registry;
    } catch {
      return registry; // keep the old registry on failure
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Lookup by Alcor id ("leef-leefmaincorp") or SYMBOL@CONTRACT. */
export function registryToken(identifier: string): AlcorTokenRow | null {
  const id = identifier.toLowerCase().replace("@", "-");
  return registry.get(id) ?? null;
}

/** Hard scam check — unknown tokens are NOT scams, just unverified. */
export function isScamToken(identifier: string): boolean {
  return registryToken(identifier)?.is_scam === true;
}

/** 0–99 venue score; 0 when unlisted. */
export function tokenScore(identifier: string): number {
  return registryToken(identifier)?.score ?? 0;
}

export function registrySize(): number {
  return registry.size;
}
