/**
 * WAX/Antelope endpoint pools.
 *
 * Two API classes, exactly as WAX's infrastructure docs separate them:
 *  - RPC (chain API): get_info / get_account / get_table_rows / push_transaction…
 *  - Hyperion (history): /v2/state, /v2/history — richer queries, never a
 *    prerequisite for the hot trading path.
 *
 * Endpoints are configurable WITHOUT source changes: a JSON blob in
 * localStorage (`leef-wax-endpoints`) can add/remove/override either pool.
 * Defaults are credible public WAX infrastructure providers (BP guilds +
 * Greymass), cross-checked against the Hyperion endpoint index and the
 * EOS Nation WAX endpoints report.
 */

export type EndpointKind = "rpc" | "history";

export type WaxEndpoint = {
  url: string;
  kind: EndpointKind;
  /** Lower = preferred when health is equal. */
  priority: number;
  enabled: boolean;
};

/**
 * Default WAX mainnet chain-RPC pool.
 * All are public Antelope chain APIs run by independent infrastructure
 * providers — a dead node here must never kill the engine.
 *
 * Live sweep 2026-09-19 (5× get_info + get_table_rows per endpoint):
 * greymass 390 ms, eosphere 470 ms (best freshness), eosusa 483 ms,
 * eosrio 541 ms, cryptolions 573 ms, waxsweden 1262 ms (~3 s block lag).
 * Dropped after that sweep: wax.blokcrafters.io (DNS ENOTFOUND ×5) and
 * hyperion.wax.eosdetroit.io (5/5 timeouts >10 s).
 */
export const DEFAULT_RPC_ENDPOINTS: WaxEndpoint[] = [
  // EOSUSA first on the strength of its chain RPC — but its Hyperion
  // rate-limits aggressively (see the history pool below), so "no rate
  // limits" is only true here. The health-scored pool still fails over on
  // downtime, latency, block lag or a bad chain id.
  { url: "https://wax.eosusa.io", kind: "rpc", priority: 1, enabled: true },
  { url: "https://wax.greymass.com", kind: "rpc", priority: 2, enabled: true },
  { url: "https://wax.eosrio.io", kind: "rpc", priority: 3, enabled: true },
  { url: "https://api.waxsweden.org", kind: "rpc", priority: 4, enabled: true },
  { url: "https://wax.eosphere.io", kind: "rpc", priority: 5, enabled: true },
  { url: "https://wax.cryptolions.io", kind: "rpc", priority: 6, enabled: true },
];

/**
 * Default Hyperion history pool (also serves /v2/state/get_tokens).
 *
 * Live sweep 2026-09-19 (3× /v2/history/get_actions per endpoint):
 * cryptolions 707 ms (fastest), eosphere 933 ms (most reliable under
 * burst), waxsweden 1159 ms. EOSUSA demoted to last: sustained HTTP 429
 * "Rate limit exceeded, retry in 1 minute" on /v2 — as the former p1 it
 * guaranteed a first-poll 429. eosrio was dropped entirely: its Hyperion
 * 3.5.0-5 registers only /v2/health — every /v2/history and /v2/state call
 * 404s (it stays in the RPC pool, where it is healthy).
 */
export const DEFAULT_HISTORY_ENDPOINTS: WaxEndpoint[] = [
  { url: "https://wax.cryptolions.io", kind: "history", priority: 1, enabled: true },
  { url: "https://wax.eosphere.io", kind: "history", priority: 2, enabled: true },
  { url: "https://api.waxsweden.org", kind: "history", priority: 3, enabled: true },
  { url: "https://wax.eosusa.io", kind: "history", priority: 4, enabled: true },
];

const STORAGE_KEY = "leef-wax-endpoints";

export type EndpointConfig = {
  rpc: string[];
  history: string[];
};

export function readEndpointConfig(): EndpointConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EndpointConfig>;
    const clean = (list: unknown): string[] =>
      Array.isArray(list)
        ? list
            .filter((u): u is string => typeof u === "string")
            .map((u) => u.trim().replace(/\/+$/, ""))
            .filter((u) => /^https?:\/\//.test(u) && !/\s/.test(u))
        : [];
    const rpc = clean(parsed.rpc);
    const history = clean(parsed.history);
    if (rpc.length === 0 && history.length === 0) return null;
    return { rpc, history };
  } catch {
    return null;
  }
}

export function writeEndpointConfig(cfg: EndpointConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  listeners.forEach((fn) => fn());
}

export function resetEndpointConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
  listeners.forEach((fn) => fn());
}

/* Config-change notifications so the provider pools can hot-reload. */
const listeners = new Set<() => void>();
export function onEndpointsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function materialize(
  defaults: WaxEndpoint[],
  override: string[],
  kind: EndpointKind,
): WaxEndpoint[] {
  if (override.length > 0) {
    return override.map((url, i) => ({ url, kind, priority: i + 1, enabled: true }));
  }
  return defaults.map((e) => ({ ...e, kind }));
}

/** Effective endpoint lists: user config overrides defaults. */
export function effectiveEndpoints(): { rpc: WaxEndpoint[]; history: WaxEndpoint[] } {
  const cfg = readEndpointConfig();
  return {
    rpc: materialize(DEFAULT_RPC_ENDPOINTS, cfg?.rpc ?? [], "rpc"),
    history: materialize(DEFAULT_HISTORY_ENDPOINTS, cfg?.history ?? [], "history"),
  };
}

/** WAX mainnet chain id — transactions are only signed/broadcast for THIS chain. */
export const WAX_CHAIN_ID =
  "1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4";
