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

/**
 * Quorum verdict over per-endpoint receipt statuses.
 *
 * `executed` is chain truth (reconcile cross-checks the transfer evidence)
 * and stays single-source. A FAILED verdict is what unlocks capital for a
 * re-trade — so one lying or stale RPC must never be enough: `failed`
 * requires agreement from ≥2 endpoints, and any executed/failed
 * disagreement stays "unknown" (locked, keep polling).
 */
export function quorumTxStatus(
  statuses: string[],
): "executed" | "soft_fail" | "hard_fail" | "unknown" {
  let executed = 0;
  let hard = 0;
  let soft = 0;
  for (const s of statuses) {
    if (s === "executed") executed += 1;
    else if (s === "hard_fail") hard += 1;
    else if (s === "soft_fail" || s === "failed") soft += 1;
  }
  if (executed > 0 && hard + soft > 0) return "unknown"; // conflicting answers
  if (executed > 0) return "executed";
  if (hard + soft >= 2) return hard > 0 ? "hard_fail" : "soft_fail";
  return "unknown";
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
          context: { operation: "WAX history tx status", endpoint: `${e.url}/v1/history/get_transaction`, params: { id: txid } },
        }),
      ),
  );
  const statuses: string[] = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    const raw = r.value as {
      trx?: { receipt?: { status?: string } };
      processed?: { receipt?: { status?: string } };
    };
    const status = raw?.trx?.receipt?.status ?? raw?.processed?.receipt?.status ?? "";
    if (status) statuses.push(status);
  }
  return quorumTxStatus(statuses);
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

/** One permission on an account that a key can satisfy on its own. */
export type KeyPermissionMatch = {
  perm: string;
  parent: string;
  /** `contract::action` pairs linked (linkauth) to this permission. */
  linked: { account: string; action: string }[];
};

type RawAccountPermissions = {
  permissions?: {
    perm_name?: string;
    parent?: string;
    required_auth?: { threshold?: number; keys?: { key?: string; weight?: number }[] };
    linked_actions?: { account?: string; action?: string }[];
  }[];
};

/**
 * Pure: every permission in a `get_account` response that one of `keys`
 * satisfies ALONE (key weight ≥ threshold). Owner is included when matched —
 * callers must refuse it (see `choosePermission`).
 */
export function parseKeyPermissions(
  raw: RawAccountPermissions,
  keys: string[],
): KeyPermissionMatch[] {
  const out: KeyPermissionMatch[] = [];
  for (const p of raw.permissions ?? []) {
    if (!p.perm_name) continue;
    const threshold = Math.max(1, Number(p.required_auth?.threshold ?? 1));
    const satisfied = (p.required_auth?.keys ?? []).some(
      (k) => !!k.key && keys.includes(k.key) && Number(k.weight ?? 0) >= threshold,
    );
    if (!satisfied) continue;
    out.push({
      perm: p.perm_name,
      parent: p.parent ?? "",
      linked: (p.linked_actions ?? [])
        .filter((l) => !!l.account)
        .map((l) => ({ account: l.account!, action: l.action ?? "" })),
    });
  }
  return out;
}

/** ALL permissions on `account` the key satisfies (reads get_account, incl. linked_actions). */
export async function permissionsForKey(
  account: string,
  keys: string[],
): Promise<KeyPermissionMatch[]> {
  const raw = (await rpcPost("/v1/chain/get_account", {
    account_name: account,
  })) as RawAccountPermissions;
  return parseKeyPermissions(raw, keys);
}

export type PermissionChoice =
  | { ok: true; permission: string; warning?: string; linked: KeyPermissionMatch["linked"] }
  | { ok: false; reason: string };

/**
 * Decide which permission a session key may sign with:
 *  - a key that controls `owner` is refused outright (even if it also holds
 *    active/custom — the key itself is too powerful to keep in a browser tab);
 *  - exactly one custom permission → use it;
 *  - several custom permissions → refuse (ambiguous, the user must pick);
 *  - only `active` → allowed, with a warning;
 *  - nothing → refused.
 */
export function choosePermission(matches: KeyPermissionMatch[]): PermissionChoice {
  if (matches.some((m) => m.perm === "owner")) {
    return {
      ok: false,
      reason:
        "This key controls the OWNER permission. Refusing to hold it — create a dedicated 'trade' permission instead (see docs/SECURITY.md).",
    };
  }
  const custom = matches.filter((m) => m.perm !== "active");
  if (custom.length === 1) {
    return { ok: true, permission: custom[0]!.perm, linked: custom[0]!.linked };
  }
  if (custom.length > 1) {
    return {
      ok: false,
      reason: `Key matches several custom permissions (${custom
        .map((m) => m.perm)
        .join(", ")}) — use a key that is on exactly one.`,
    };
  }
  const active = matches.find((m) => m.perm === "active");
  if (active) {
    return {
      ok: true,
      permission: "active",
      linked: active.linked,
      warning:
        "ACTIVE key: it can move ALL funds and change permissions. Prefer a dedicated 'trade' permission linked only to the swap/transfer actions.",
    };
  }
  return { ok: false, reason: "Key does not satisfy any permission on this account on its own." };
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
