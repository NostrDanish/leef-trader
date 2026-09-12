/**
 * Shared capital-movement coordinator.
 *
 * Bot, manual swaps, rebalancer and LP management must acquire the same lock.
 * This module owns lifecycle transitions and reconciliation; no subsystem may
 * mark a broadcast as a fill before chain confirmation.
 */
import {
  abortSigning,
  beginSigning,
  liveCapitalBlocked,
  markBroadcast,
  markConfirmed,
  markFailed,
  markReconciling,
  markUnknown,
  unknownBlockReason,
} from "./trade-cycle";
import { reconcileTransfersLater, waitForTransaction, type ReconcileResult } from "./reconcile";

export type CapitalOwner = "bot" | "manual" | "rebalancer" | "liquidity";

export type CoordinatedResult<T> = {
  value: T;
  txid: string;
  reconciliation: ReconcileResult;
};

export class CapitalBusyError extends Error {
  constructor(readonly owner: CapitalOwner, message: string) {
    super(message);
    this.name = "CapitalBusyError";
  }
}

export function capitalAvailable(): boolean {
  return !liveCapitalBlocked();
}

/**
 * Run exactly one capital-moving submission and reconcile it. `submit` must
 * perform fresh quote/policy/sign/broadcast and return its txid. This function
 * never retries a transaction. UNKNOWN keeps the global lock.
 */
export async function coordinateCapitalMovement<T extends { txid: string }>(opts: {
  owner: CapitalOwner;
  submit: () => Promise<T>;
  confirmation?: { budgetMs?: number; attempts?: number; delayMs?: number };
  onSettled?: (result: ReconcileResult) => void | Promise<void>;
}): Promise<CoordinatedResult<T>> {
  if (!beginSigning()) {
    throw new CapitalBusyError(
      opts.owner,
      unknownBlockReason() ?? "Another trade is signing, broadcasting, or reconciling",
    );
  }
  let broadcasted = false;
  try {
    const value = await opts.submit();
    const txid = value.txid;
    broadcasted = true;
    markBroadcast(txid);
    markReconciling(txid);
    const reconciliation = await waitForTransaction(txid, {
      budgetMs: opts.confirmation?.budgetMs ?? 2_500,
      attempts: opts.confirmation?.attempts ?? 5,
      delayMs: opts.confirmation?.delayMs ?? 300,
    });
    if (reconciliation.status === "confirmed") {
      markConfirmed();
      await opts.onSettled?.(reconciliation);
    } else if (reconciliation.status === "failed") {
      markFailed();
      await opts.onSettled?.(reconciliation);
    } else {
      markUnknown(txid);
      await opts.onSettled?.(reconciliation);
      // Read-only background reconciliation. UNKNOWN remains locked until
      // chain truth says confirmed or failed.
      void reconcileTransfersLater(txid).then(async (later) => {
        if (later.status === "confirmed") markConfirmed();
        else if (later.status === "failed") markFailed();
        await opts.onSettled?.(later);
      });
    }
    return { value, txid, reconciliation };
  } catch (err) {
    // sign.ts marks ambiguous broadcast timeout UNKNOWN itself. Never unlock
    // it here. Pre-broadcast/policy/rejection failures may safely release.
    if (!broadcasted && !unknownBlockReason()) abortSigning();
    throw err;
  }
}
