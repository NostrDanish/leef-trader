/**
 * Account history backfill — pull the wallet's own past swaps from Hyperion
 * (EOSUSA-first via the health-scored history pool) into the evidence
 * journal.
 *
 * What backfilled entries teach: real historical executions with amounts,
 * txids and timestamps (strategy "backfill"). What they DON'T: predicted
 * edges or expected outputs — those are unknowable in hindsight, so backfill
 * entries carry `source: "backfill"` and the learning profiles skip them.
 * They never fabricate calibration.
 *
 * The Alcor swaps API remains the trade-tape source of truth; Hyperion is
 * for account/chain history. Division of labor matches the venue docs.
 */
import { fetchJson } from "@/lib/fetchJson";
import { journal, journalAll, type JournalEntry } from "@/lib/leef/journal";
import { historyPool } from "@/lib/wax/provider-pool";
import { parseAsset } from "./tokens";

/** Venue swap contracts — a tx only counts as a swap if one is involved. */
const VENUE_CONTRACTS = new Set(["swap.alcor", "swap.box", "swap.taco"]);

export type HyperionActionRow = {
  trx_id?: unknown;
  timestamp?: unknown;
  act?: {
    account?: unknown;
    name?: unknown;
    data?: { from?: unknown; to?: unknown; quantity?: unknown; memo?: unknown };
  };
};

export type NetTransfer = {
  key: string; // SYMBOL@contract
  symbol: string;
  contract: string;
  /** Positive = the account received; negative = the account sent. */
  net: number;
  /** Gross sums — a round trip nets to one kind but has both legs. */
  sent: number;
  received: number;
};

/** Pure: per-token movement of `account` inside one transaction. */
export function netTransfers(
  rows: HyperionActionRow[],
  account: string,
): { nets: NetTransfer[]; touchesVenue: boolean } {
  const byKey = new Map<string, NetTransfer>();
  let touchesVenue = false;
  for (const row of rows) {
    const act = row.act;
    if (!act || act.name !== "transfer") continue;
    const from = typeof act.data?.from === "string" ? act.data.from : "";
    const to = typeof act.data?.to === "string" ? act.data.to : "";
    if (VENUE_CONTRACTS.has(from) || VENUE_CONTRACTS.has(to)) touchesVenue = true;
    if (from !== account && to !== account) continue;
    const contract = typeof act.account === "string" ? act.account : "";
    const parsed = parseAsset(typeof act.data?.quantity === "string" ? act.data.quantity : "");
    if (!parsed || !(parsed.amount > 0) || !contract) continue;
    const key = `${parsed.symbol}@${contract}`;
    let e = byKey.get(key);
    if (!e) {
      e = { key, symbol: parsed.symbol, contract, net: 0, sent: 0, received: 0 };
      byKey.set(key, e);
    }
    if (to === account) {
      e.net += parsed.amount;
      e.received += parsed.amount;
    } else {
      e.net -= parsed.amount;
      e.sent += parsed.amount;
    }
  }
  return {
    nets: [...byKey.values()].filter((n) => Math.abs(n.net) > 1e-12 || (n.sent > 0 && n.received > 0)),
    touchesVenue,
  };
}

export type BackfillSwap = {
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  amountOut: number;
};

/**
 * Pure: classify one transaction's shape. A swap = exactly one sent kind +
 * one received kind, venue-touched. A same-kind venue round trip (arb/echo)
 * nets to a single kind but has both legs. LP adds/removes (two sends or two
 * receives), pure transfers and contract noise are excluded by shape.
 */
export function swapFromTransfers(
  rows: HyperionActionRow[],
  account: string,
): BackfillSwap | null {
  const { nets, touchesVenue } = netTransfers(rows, account);
  if (!touchesVenue) return null;
  const sentKinds = nets.filter((n) => n.sent > 0);
  const receivedKinds = nets.filter((n) => n.received > 0);
  if (sentKinds.length === 1 && receivedKinds.length === 1) {
    const s = sentKinds[0]!;
    const r = receivedKinds[0]!;
    if (s.key === r.key) {
      // Round trip in one token (arb/echo): gross legs carry the amounts.
      return { tokenIn: s.symbol, tokenOut: r.symbol, amountIn: s.sent, amountOut: r.received };
    }
    return { tokenIn: s.symbol, tokenOut: r.symbol, amountIn: s.sent, amountOut: r.received };
  }
  // Arb/echo through an intermediate token: the pass-through legs cancel to
  // zero net, leaving one unbalanced token whose GROSS legs are in/out.
  const unbalanced = nets.filter((n) => n.sent > 0 && n.received > 0 && Math.abs(n.net) > 1e-12);
  if (
    unbalanced.length === 1 &&
    nets.every((n) => n === unbalanced[0] || Math.abs(n.net) <= 1e-12)
  ) {
    const b = unbalanced[0]!;
    return { tokenIn: b.symbol, tokenOut: b.symbol, amountIn: b.sent, amountOut: b.received };
  }
  return null;
}

function groupByTx(rows: HyperionActionRow[]): Map<string, HyperionActionRow[]> {
  const map = new Map<string, HyperionActionRow[]>();
  for (const row of rows) {
    const txid = typeof row.trx_id === "string" ? row.trx_id : "";
    if (!txid) continue;
    const list = map.get(txid) ?? [];
    list.push(row);
    map.set(txid, list);
  }
  return map;
}

export type BackfillResult = {
  scanned: number;
  transactions: number;
  imported: number;
  skippedDupe: number;
  skippedShape: number;
  note: string;
};

/**
 * Page Hyperion get_actions (newest first), import swap-shaped transactions
 * as backfill executions. Dedupes against already-journaled txids.
 */
export async function backfillAccountHistory(opts: {
  account: string;
  days?: number;
  maxActions?: number;
}): Promise<BackfillResult> {
  const days = Math.min(30, Math.max(1, opts.days ?? 7));
  const maxActions = Math.min(1_000, Math.max(50, opts.maxActions ?? 400));
  const after = new Date(Date.now() - days * 86_400_000).toISOString();

  const existing = new Set<string>();
  for (const e of await journalAll()) {
    if (e.kind === "execution" && e.txid) existing.add(e.txid);
  }

  const hosts = historyPool
    .health()
    .filter((h) => h.status !== "disabled")
    .slice(0, 3);
  if (hosts.length === 0) {
    return { scanned: 0, transactions: 0, imported: 0, skippedDupe: 0, skippedShape: 0, note: "No healthy Hyperion endpoint" };
  }

  let scanned = 0;
  let imported = 0;
  let skippedDupe = 0;
  let skippedShape = 0;
  let transactions = 0;
  let lastError = "";

  outer: for (const host of hosts) {
    try {
      for (let skip = 0; skip < maxActions; skip += 100) {
        const url =
          `${host.url}/v2/history/get_actions?account=${encodeURIComponent(opts.account)}` +
          `&filter=${encodeURIComponent("*:transfer")}&sort=desc&limit=100&skip=${skip}` +
          `&after=${encodeURIComponent(after)}`;
        const raw = await fetchJson(url, {
          timeoutMs: 10_000,
          priority: "low",
          context: { operation: "Hyperion backfill", endpoint: `${host.url}/v2/history/get_actions`, params: { skip } },
        });
        const actions = (raw as { actions?: unknown }).actions;
        if (!Array.isArray(actions) || actions.length === 0) break;
        scanned += actions.length;

        for (const [txid, rows] of groupByTx(actions as HyperionActionRow[])) {
          transactions += 1;
          if (existing.has(txid)) {
            skippedDupe += 1;
            continue;
          }
          const swap = swapFromTransfers(rows, opts.account);
          if (!swap) {
            skippedShape += 1;
            continue;
          }
          const ts = Date.parse(
            typeof rows[0]?.timestamp === "string" ? rows[0].timestamp : "",
          );
          const entry: Omit<JournalEntry, "ts"> & { ts?: number } = {
            kind: "execution",
            action: swap.tokenIn === swap.tokenOut ? "arb" : "swap",
            strategy: "backfill",
            mode: "live",
            status: "confirmed",
            tokenIn: swap.tokenIn,
            tokenOut: swap.tokenOut,
            amountIn: swap.amountIn,
            actualOut: swap.amountOut,
            txid,
            source: "backfill",
            reason: `backfill: ${swap.amountIn.toFixed(6)} ${swap.tokenIn} → ${swap.amountOut.toFixed(6)} ${swap.tokenOut}`,
          };
          if (Number.isFinite(ts)) entry.ts = ts;
          journal(entry);
          existing.add(txid);
          imported += 1;
        }
        if (actions.length < 100) break; // last page
      }
      break outer; // a host answered — done
    } catch (err) {
      lastError = err instanceof Error ? err.message : "backfill failed";
      // next host
    }
  }

  return {
    scanned,
    transactions,
    imported,
    skippedDupe,
    skippedShape,
    note:
      imported > 0
        ? `Imported ${imported} historical swaps`
        : lastError
          ? `Backfill failed: ${lastError}`
          : "No new swaps found in range",
  };
}
