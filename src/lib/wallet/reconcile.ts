/**
 * Transaction reconciliation.
 *
 * A broadcast txid is NOT a fill. After every live trade we confirm inclusion
 * then read actual token transfers. Those deltas — not the router's quote —
 * update positions, P&L and the journal.
 *
 * Fast path: RPC /v1/history/get_transaction (block inclusion).
 * Fallback: Hyperion /v2/history/get_transaction (transfer parse).
 *
 * Statuses:
 *  - confirmed: the tx executed; transfers were parsed when available.
 *  - failed:    the tx is on-chain but did not execute (nothing moved).
 *  - unknown:   no node has it (yet). NEVER retry the trade on unknown —
 *               the tx may still land; retrying is how double spends happen.
 */
import { fetchJson } from "@/lib/fetchJson";
import { getTransactionStatus } from "./chain";
import { historyPool } from "@/lib/wax/provider-pool";
import { parseAsset } from "./tokens";

export type TxTransfer = {
  contract: string;
  from: string;
  to: string;
  quantity: string;
  amount: number;
  symbol: string;
  memo: string;
};

export type ReconcileResult =
  | { status: "confirmed"; txid: string; transfers: TxTransfer[] }
  | { status: "failed"; txid: string; error: string }
  | { status: "unknown"; txid: string };

type HyperionAction = {
  act?: {
    account?: unknown;
    name?: unknown;
    data?: unknown;
  };
};

/**
 * Pure: pull every token transfer out of a Hyperion get_transaction response.
 * Returns null when the response doesn't look like an indexed transaction
 * (not found yet, wrong shape) so callers keep polling.
 */
export function parseHyperionTransfers(
  raw: unknown,
): { executed: boolean; transfers: TxTransfer[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as { executed?: unknown; actions?: unknown };
  if (!Array.isArray(root.actions) || root.actions.length === 0) return null;
  const executed = root.executed !== false;
  const transfers: TxTransfer[] = [];
  for (const row of root.actions as HyperionAction[]) {
    const act = row?.act;
    if (!act || act.name !== "transfer") continue;
    const contract = typeof act.account === "string" ? act.account : "";
    const data = (act.data ?? {}) as Record<string, unknown>;
    const from = typeof data.from === "string" ? data.from : "";
    const to = typeof data.to === "string" ? data.to : "";
    const quantity = typeof data.quantity === "string" ? data.quantity : "";
    const memo = typeof data.memo === "string" ? data.memo : "";
    if (!contract || !from || !to || !quantity) continue;
    const asset = parseAsset(quantity);
    if (!asset) continue;
    transfers.push({
      contract,
      from,
      to,
      quantity,
      amount: asset.amount,
      symbol: asset.symbol,
      memo,
    });
  }
  return { executed, transfers };
}

/**
 * Net balance delta for one token from the account's perspective:
 * incoming minus outgoing. Positive = received.
 */
export function assetDelta(
  transfers: TxTransfer[],
  account: string,
  symbol: string,
  contract?: string,
): number {
  let delta = 0;
  for (const t of transfers) {
    if (t.symbol !== symbol) continue;
    if (contract && t.contract !== contract) continue;
    if (t.to === account) delta += t.amount;
    if (t.from === account) delta -= t.amount;
  }
  return delta;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function hyperionOnce(txid: string): Promise<ReconcileResult | null> {
  const hosts = historyPool
    .health()
    .filter((e) => e.status !== "disabled")
    .slice(0, 3);
  for (const e of hosts) {
    try {
      const raw = await fetchJson(
        `${e.url}/v2/history/get_transaction?id=${encodeURIComponent(txid)}`,
        {
          timeoutMs: 5_000,
          priority: "high",
          context: { operation: "Hyperion tx lookup", endpoint: `${e.url}/v2/history/get_transaction`, params: { id: txid } },
        },
      );
      const parsed = parseHyperionTransfers(raw);
      if (!parsed) continue;
      if (!parsed.executed) {
        return { status: "failed", txid, error: "Transaction failed on-chain — nothing moved" };
      }
      return { status: "confirmed", txid, transfers: parsed.transfers };
    } catch {
      /* next host */
    }
  }
  return null;
}

/**
 * Confirm inclusion as quickly as the chain will tell us.
 *
 * 1. RPC history status (block inclusion) — usually sub-second after land.
 * 2. Hyperion for transfer parse (needed for exact fill amounts).
 *
 * Default budget is short on the HOT path (~1.2s). Callers that need full
 * transfer reconciliation can pass a longer budget; the bot should NOT
 * hold the next-decision lock on Hyperion lag.
 */
export async function waitForTransaction(
  txid: string,
  opts?: { attempts?: number; delayMs?: number; budgetMs?: number },
): Promise<ReconcileResult> {
  const budgetMs = opts?.budgetMs ?? 1_200;
  const attempts = Math.max(1, opts?.attempts ?? 3);
  const delayMs = Math.max(80, opts?.delayMs ?? 250);
  const t0 = Date.now();

  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs);
    if (Date.now() - t0 > budgetMs) break;

    const rpc = await getTransactionStatus(txid);
    if (rpc === "hard_fail" || rpc === "soft_fail") {
      return { status: "failed", txid, error: "Transaction failed on-chain — nothing moved" };
    }

    const hyp = await hyperionOnce(txid);
    if (hyp) return hyp;

    // Included but Hyperion hasn't indexed transfers yet — still a fill.
    if (rpc === "executed") {
      return { status: "confirmed", txid, transfers: [] };
    }
  }
  return { status: "unknown", txid };
}

/**
 * Background transfer parse after a fast inclusion confirm. Never retries
 * the original transaction — only reads history.
 */
export async function reconcileTransfersLater(
  txid: string,
  opts?: { attempts?: number; delayMs?: number },
): Promise<ReconcileResult> {
  return await waitForTransaction(txid, {
    attempts: opts?.attempts ?? 8,
    delayMs: opts?.delayMs ?? 800,
    budgetMs: 12_000,
  });
}
