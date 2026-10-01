/**
 * Pre-broadcast simulation via `/v1/chain/compute_transaction`.
 *
 * Before the session key signs, the exact packed transaction is executed
 * read-only by a node (unsigned, nothing is committed, no CPU billed). The
 * real contracts run — Alcor/Taco min-out asserts, token `overdrawn balance`,
 * paused pools — so a transaction that would revert is refused before it
 * costs CPU or leaves a failed tx on the account.
 *
 * Lesson from live WAX trading (2026-10-01): several public nodes returned
 * SUCCESS from compute_transaction for an Alcor swap whose min-out was NOT
 * met (they don't enforce contract assertions there). Only nodes verified to
 * enforce them are used by default; the list is configurable.
 *
 * Failure policy:
 *   - the node ran the transaction and it asserted   → refuse (fail closed);
 *   - no simulation node reachable / unusable answer → mode "auto" proceeds
 *     (the on-chain min-outs still protect the trade), mode "require" refuses.
 */
import { bytesToHex } from "@noble/hashes/utils.js";

/** Nodes observed to enforce contract assertions in compute_transaction. */
export const DEFAULT_SIMULATION_NODES = ["https://wax.eosusa.io", "https://api.waxsweden.org"];

export type SimulationMode = "off" | "auto" | "require";

export type SimulationResult =
  | { ok: true; node: string; cpuUs: number | null; elapsedUs: number | null }
  | { ok: false; kind: "assert"; node: string; reason: string }
  | { ok: false; kind: "unreachable"; reason: string };

type ComputeResponse = {
  processed?: {
    receipt?: { cpu_usage_us?: number };
    elapsed?: number;
    except?: unknown;
  };
  error?: {
    what?: string;
    name?: string;
    details?: { message?: string }[];
  };
};

/** Human message for a compute_transaction error body (contract assert first). */
export function simulationErrorMessage(err: NonNullable<ComputeResponse["error"]>): string {
  const detail = (err.details ?? [])
    .map((d) => d.message ?? "")
    .filter(Boolean)
    .join(" | ");
  const text = (detail || err.what || err.name || "simulation failed")
    .replace(/assertion failure with message:?\s*/gi, "")
    .trim();
  return text.slice(0, 300);
}

/** Pure: classify one node's JSON answer. null = unusable answer (try the next node). */
export function parseComputeResponse(node: string, json: unknown): SimulationResult | null {
  if (!json || typeof json !== "object") return null;
  const j = json as ComputeResponse;
  if (j.error) return { ok: false, kind: "assert", node, reason: simulationErrorMessage(j.error) };
  if (j.processed) {
    if (j.processed.except) {
      return { ok: false, kind: "assert", node, reason: "transaction raised an exception in simulation" };
    }
    return {
      ok: true,
      node,
      cpuUs: typeof j.processed.receipt?.cpu_usage_us === "number" ? j.processed.receipt.cpu_usage_us : null,
      elapsedUs: typeof j.processed.elapsed === "number" ? j.processed.elapsed : null,
    };
  }
  return null;
}

export type SimulationFetcher = (url: string, body: string, timeoutMs: number) => Promise<unknown>;

const defaultFetcher: SimulationFetcher = async (url, body, timeoutMs) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Antelope answers asserts with HTTP 500 + a JSON error body — read it either way.
  return await res.json().catch(() => null);
};

/**
 * Simulate an UNSIGNED packed transaction on the first reachable
 * assertion-enforcing node. Never broadcasts.
 */
export async function simulatePackedTransaction(
  packedTx: Uint8Array,
  opts: { nodes?: string[]; timeoutMs?: number; fetcher?: SimulationFetcher } = {},
): Promise<SimulationResult> {
  const nodes = opts.nodes ?? DEFAULT_SIMULATION_NODES;
  const fetcher = opts.fetcher ?? defaultFetcher;
  const body = JSON.stringify({
    transaction: {
      signatures: [],
      compression: 0,
      packed_context_free_data: "",
      packed_trx: bytesToHex(packedTx),
    },
  });
  const errors: string[] = [];
  for (const node of nodes) {
    try {
      const json = await fetcher(`${node.replace(/\/+$/, "")}/v1/chain/compute_transaction`, body, opts.timeoutMs ?? 2_500);
      const parsed = parseComputeResponse(node, json);
      if (parsed) return parsed;
      errors.push(`${node}: unusable answer`);
    } catch (err) {
      errors.push(`${node}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    ok: false,
    kind: "unreachable",
    reason: `no simulation node answered (${errors.join("; ") || "none configured"})`,
  };
}
