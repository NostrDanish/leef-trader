import { parseAsset, type TokenMeta } from "./tokens";
import { fetchJson } from "@/lib/fetchJson";

/**
 * Public WAX (Antelope) RPC endpoints. Called directly from the browser;
 * fetchJson retries through a CORS proxy if a node doesn't allow the origin.
 */
const WAX_RPC = [
  "https://wax.greymass.com",
  "https://wax.eosrio.io",
  "https://api.waxsweden.org",
  "https://wax.eosphere.io",
];

export async function rpcPost(
  path: string,
  body: unknown,
  timeoutMs = 12_000,
  priority: "high" | "medium" | "low" = "medium",
): Promise<unknown> {
  let last = "WAX RPC failed";
  for (const base of WAX_RPC) {
    try {
      return await fetchJson(`${base}${path}`, { method: "POST", body, timeoutMs, priority });
    } catch (err) {
      last = err instanceof Error ? err.message : last;
    }
  }
  throw new Error(last);
}

/** Fast inclusion check — does not wait for Hyperion history indexing. */
export async function getTransactionStatus(
  txid: string,
): Promise<"executed" | "soft_fail" | "hard_fail" | "unknown"> {
  const body = { id: txid };
  const settled = await Promise.allSettled(
    WAX_RPC.slice(0, 2).map((base) =>
      fetchJson(`${base}/v1/history/get_transaction`, {
        method: "POST",
        body,
        timeoutMs: 700,
        priority: "high",
      }),
    ),
  );
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    const raw = r.value as {
      trx?: { receipt?: { status?: string } };
      processed?: { receipt?: { status?: string } };
    };
    const status = raw?.trx?.receipt?.status ?? raw?.processed?.receipt?.status ?? "";
    if (status === "executed") return "executed";
    if (status === "hard_fail") return "hard_fail";
    if (status === "soft_fail" || status === "failed") return "soft_fail";
  }
  return "unknown";
}

export type ChainAccount = {
  name: string;
  cpuPct: number | null;
  netPct: number | null;
  ramPct: number | null;
};

/**
 * Execution preflight: WAX resources too exhausted to trade reliably.
 * Returns the reason, or null when the account is healthy. Fail open on
 * unknown (null) readings — the chain itself rejects an unpayable tx — but
 * never trade through a KNOWN-exhausted resource.
 */
export function waxResourceBlock(
  cpuPct: number | null,
  netPct: number | null,
  ramPct: number | null,
): string | null {
  if (cpuPct != null && cpuPct > 0.95) {
    return `WAX CPU ${(cpuPct * 100).toFixed(0)}% used — pausing trades until it regenerates`;
  }
  if (netPct != null && netPct > 0.98) {
    return `WAX NET ${(netPct * 100).toFixed(0)}% used — pausing trades until it regenerates`;
  }
  if (ramPct != null && ramPct > 0.98) {
    return `WAX RAM ${(ramPct * 100).toFixed(0)}% used — pausing trades`;
  }
  return null;
}

export type KeyAccount = {
  name: string;
  /** On-chain permission the key authorizes, e.g. "active". */
  permission: string;
};

/** Find WAX accounts (and the permission) controlled by the given public keys. */
export async function accountsForKeys(keys: string[]): Promise<KeyAccount[]> {
  const found = new Map<string, string>();
  try {
    const raw = (await rpcPost("/v1/chain/get_accounts_by_authorizers", {
      accounts: [],
      keys,
    })) as { accounts?: { account_name?: string; permission_name?: string }[] };
    for (const row of raw.accounts ?? []) {
      if (row.account_name && !found.has(row.account_name)) {
        found.set(row.account_name, row.permission_name || "active");
      }
    }
  } catch {
    /* fall through to the history plugin */
  }
  if (found.size === 0) {
    for (const key of keys) {
      try {
        const raw = (await rpcPost("/v1/history/get_key_accounts", {
          public_key: key,
        })) as { account_names?: string[] };
        for (const n of raw.account_names ?? []) {
          if (!found.has(n)) found.set(n, "active");
        }
      } catch {
        /* node doesn't serve the history plugin */
      }
    }
  }
  return [...found].map(([name, permission]) => ({ name, permission }));
}

/**
 * Resolve which permission on `account` holds one of `keys` — so imports of a
 * custom trading permission (not just "active") sign with the right auth.
 */
export async function permissionForKey(account: string, keys: string[]): Promise<string> {
  try {
    const raw = (await rpcPost("/v1/chain/get_account", { account_name: account })) as {
      permissions?: {
        perm_name?: string;
        required_auth?: { keys?: { key?: string }[] };
      }[];
    };
    for (const perm of raw.permissions ?? []) {
      for (const k of perm.required_auth?.keys ?? []) {
        if (k.key && keys.includes(k.key)) return perm.perm_name || "active";
      }
    }
  } catch {
    /* default below */
  }
  return "active";
}

export async function accountResources(name: string): Promise<ChainAccount> {
  const raw = (await rpcPost("/v1/chain/get_account", { account_name: name })) as {
    cpu_limit?: { used?: number; max?: number };
    net_limit?: { used?: number; max?: number };
    ram_quota?: number;
    ram_usage?: number;
  };
  const pct = (lim?: { used?: number; max?: number }) => {
    const max = lim?.max ?? 0;
    const used = lim?.used ?? 0;
    return max > 0 ? used / max : null;
  };
  const ramQuota = typeof raw.ram_quota === "number" ? raw.ram_quota : 0;
  const ramUsage = typeof raw.ram_usage === "number" ? raw.ram_usage : 0;
  return {
    name,
    cpuPct: pct(raw.cpu_limit),
    netPct: pct(raw.net_limit),
    ramPct: ramQuota > 0 ? ramUsage / ramQuota : null,
  };
}

export async function fetchBalances(
  account: string,
  tokens: TokenMeta[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const unique = tokens.filter(
    (t, i, arr) => arr.findIndex((x) => x.symbol === t.symbol && x.contract === t.contract) === i,
  );
  await Promise.all(
    unique.map(async (t) => {
      try {
        const raw = await rpcPost("/v1/chain/get_currency_balance", {
          code: t.contract,
          account,
          symbol: t.symbol,
        });
        const row = Array.isArray(raw) ? raw[0] : null;
        const parsed = typeof row === "string" ? parseAsset(row) : null;
        out[t.symbol] = parsed?.amount ?? 0;
      } catch {
        out[t.symbol] = out[t.symbol] ?? 0;
      }
    }),
  );
  return out;
}

export async function getChainInfo(): Promise<unknown> {
  return await rpcPost("/v1/chain/get_info", {}, 8_000);
}

/* ------------------------------------------------------------------ */
/* Full wallet token scan (Hyperion)                                   */
/* ------------------------------------------------------------------ */

/** Hyperion history endpoints (also used by the reconciler). */
export const HYPERION = [
  "https://api.waxsweden.org",
  "https://wax.eosphere.io",
  "https://wax.eosusa.io",
];

export type TokenBalance = {
  symbol: string;
  contract: string;
  decimals: number;
  amount: number;
};

/**
 * Every token balance of an account in one Hyperion call.
 * Falls back to per-token /v1/chain/get_currency_balance for `known` tokens
 * when no Hyperion endpoint answers.
 */
export async function fetchAllBalances(
  account: string,
  known: TokenMeta[],
): Promise<TokenBalance[]> {
  for (const base of HYPERION) {
    try {
      const raw = (await fetchJson(
        `${base}/v2/state/get_tokens?account=${encodeURIComponent(account)}&limit=400`,
        { timeoutMs: 10_000 },
      )) as {
        tokens?: { symbol?: string; precision?: number; amount?: number; contract?: string }[];
      };
      if (raw && Array.isArray(raw.tokens)) {
        return raw.tokens
          .filter((t) => t && typeof t.amount === "number" && t.symbol && t.contract)
          .map((t) => ({
            symbol: String(t.symbol).toUpperCase(),
            contract: String(t.contract),
            decimals: Number(t.precision ?? 4) || 4,
            amount: t.amount as number,
          }));
      }
    } catch {
      /* try the next Hyperion endpoint */
    }
  }
  const bal = await fetchBalances(account, known);
  return known.map((t) => ({
    symbol: t.symbol,
    contract: t.contract,
    decimals: t.decimals,
    amount: bal[t.symbol] ?? 0,
  }));
}

export async function pushSigned(signed: unknown): Promise<{ txid: string }> {
  const raw = (await rpcPost("/v1/chain/push_transaction", signed, 15_000)) as {
    transaction_id?: string;
    processed?: { id?: string };
  };
  const txid = raw.transaction_id ?? raw.processed?.id;
  if (!txid) throw new Error("Broadcast did not return a transaction id");
  return { txid };
}
