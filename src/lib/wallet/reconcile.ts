/**
 * Transaction reconciliation.
 *
 * A broadcast txid is NOT a fill. After every live trade we fetch the actual
 * transaction from a Hyperion history node and read the real token transfers
 * out of it: what actually left the wallet, what actually came back. Those
 * deltas — not the router's quote — update positions, P&L and the journal.
 *
 * Statuses:
 *  - confirmed: the tx executed; transfers were parsed.
 *  - failed:    the tx is on-chain but did not execute (nothing moved).
 *  - unknown:   no history node has it (yet). NEVER retry the trade on
 *               unknown — the tx may still land; retrying is how double
 *               spends happen. Reconcile first, trade later.
 */
import { fetchJson } from "@/lib/fetchJson";
import { HYPERION } from "./chain";
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

/**
 * Poll Hyperion until the transaction is indexed (or we give up).
 * Default budget ≈ 4 attempts × 2.5s + request time ≈ 12–15s, which covers
 * Hyperion's indexing lag after a successful broadcast.
 */
export async function waitForTransaction(
  txid: string,
  opts?: { attempts?: number; delayMs?: number },
): Promise<ReconcileResult> {
  const attempts = Math.max(1, opts?.attempts ?? 4);
  const delayMs = Math.max(250, opts?.delayMs ?? 2_500);
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs);
    for (const base of HYPERION) {
      try {
        const raw = await fetchJson(
          `${base}/v2/history/get_transaction?id=${encodeURIComponent(txid)}`,
          { timeoutMs: 8_000 },
        );
        const parsed = parseHyperionTransfers(raw);
        if (!parsed) continue; // not indexed yet — try the next host/attempt
        if (!parsed.executed) {
          return { status: "failed", txid, error: "Transaction failed on-chain — nothing moved" };
        }
        return { status: "confirmed", txid, transfers: parsed.transfers };
      } catch {
        /* try the next Hyperion host */
      }
    }
  }
  return { status: "unknown", txid };
}
