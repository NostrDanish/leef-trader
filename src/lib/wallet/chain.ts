import { parseAsset, type TokenMeta } from "./tokens";
import { fetchJson } from "@/lib/fetchJson";
import { historyPool, rpcPool, BroadcastTimeoutError } from "@/lib/wax/provider-pool";

export { BroadcastTimeoutError };

/**
 * WAX chain access — every call goes through the health-scored provider
 * pools (src/lib/wax/provider-pool.ts). No hardcoded endpoint lists, no
 * blind sequential retry:
 *
 *  - READS: best-health endpoint first, automatic failover.
 *  - TRANSACTIONS: ONE submission to a trading-eligible node. A timeout
 *    surfaces as BroadcastTimeoutError for reconciliation — the signed
 *    payload is never blindly re-broadcast.
 */

export async function rpcPost(
  path: string,
  body: unknown,
  timeoutMs = 12_000,
  priority: "high" | "medium" | "low" = "medium",
): Promise<unknown> {
  return await rpcPool.call(path, body, { timeoutMs, priority });
}

/** Fast inclusion check — does not wait for Hyperion history indexing. */
export async function getTransactionStatus(
  txid: string,
): Promise<"executed" | "soft_fail" | "hard_fail" | "unknown"> {
  const body = { id: txid };
  const settled = await Promise.allSettled(
    rpcPool
      .health()
      .filter((e) => e.status !== "disabled")
      .slice(0, 3)
      .map((e) =>
        fetchJson(`${e.url}/v1/history/get_transaction`, {
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
  return await rpcPool.getInfo(8_000);
}

/** Head-block snapshot for the engine heartbeat (also feeds health scores). */
export async function headInfo(): Promise<{
  headBlock: number;
  libBlock: number;
  headBlockTime: string;
  chainId: string;
}> {
  const info = await rpcPool.getInfo(4_000);
  return {
    headBlock: Number(info.head_block_num ?? 0),
    libBlock: Number(info.last_irreversible_block_num ?? 0),
    headBlockTime: String(info.head_block_time ?? ""),
    chainId: String(info.chain_id ?? ""),
  };
}

/* ------------------------------------------------------------------ */
/* Full wallet token scan (Hyperion history pool)                       */
/* ------------------------------------------------------------------ */

export type TokenBalance = {
  symbol: string;
  contract: string;
  decimals: number;
  amount: number;
};

/**
 * Every token balance of an account in one Hyperion call (history pool with
 * failover). Falls back to per-token /v1/chain/get_currency_balance for
 * `known` tokens when no Hyperion endpoint answers.
 */
export async function fetchAllBalances(
  account: string,
  known: TokenMeta[],
): Promise<TokenBalance[]> {
  try {
    const raw = (await historyPool.call(
      `/v2/state/get_tokens?account=${encodeURIComponent(account)}&limit=400`,
      undefined,
      { timeoutMs: 10_000, priority: "medium", method: "GET" },
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
    /* fall back to chain RPC below */
  }
  const bal = await fetchBalances(account, known);
  return known.map((t) => ({
    symbol: t.symbol,
    contract: t.contract,
    decimals: t.decimals,
    amount: bal[t.symbol] ?? 0,
  }));
}

/**
 * Broadcast a SIGNED transaction. Exactly ONE submission to a
 * trading-eligible node. No failover and no retry here — regardless of HTTP
 * vs network failure. The caller knows sha256(packed_trx) before this call,
 * so any ambiguous response can be reconciled safely without a duplicate.
 */
export async function pushSigned(signed: unknown): Promise<{ txid: string }> {
  const raw = await rpcPool.pushTransaction("/v1/chain/push_transaction", signed, {
    timeoutMs: 15_000,
    priority: "high",
  });
  const r = raw as { transaction_id?: string; processed?: { id?: string } };
  const txid = r.transaction_id ?? r.processed?.id;
  if (!txid) throw new Error("Broadcast did not return a transaction id");
  return { txid };
}
