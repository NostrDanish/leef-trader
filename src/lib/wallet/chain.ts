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

async function rpcPost(path: string, body: unknown, timeoutMs = 12_000): Promise<unknown> {
  let last = "WAX RPC failed";
  for (const base of WAX_RPC) {
    try {
      return await fetchJson(`${base}${path}`, { method: "POST", body, timeoutMs });
    } catch (err) {
      last = err instanceof Error ? err.message : last;
    }
  }
  throw new Error(last);
}

export type ChainAccount = {
  name: string;
  cpuPct: number | null;
  netPct: number | null;
};

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
  };
  const pct = (lim?: { used?: number; max?: number }) => {
    const max = lim?.max ?? 0;
    const used = lim?.used ?? 0;
    return max > 0 ? used / max : null;
  };
  return { name, cpuPct: pct(raw.cpu_limit), netPct: pct(raw.net_limit) };
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

export async function pushSigned(signed: unknown): Promise<{ txid: string }> {
  const raw = (await rpcPost("/v1/chain/push_transaction", signed, 15_000)) as {
    transaction_id?: string;
    processed?: { id?: string };
  };
  const txid = raw.transaction_id ?? raw.processed?.id;
  if (!txid) throw new Error("Broadcast did not return a transaction id");
  return { txid };
}
