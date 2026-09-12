/** Failure classes and safe retry decisions for the execution coordinator. */
import { TradeError, classifyTradeError, type TradeErrorCode } from "./trade-error";

export type ExecutionFailureClass =
  | "NO_OPPORTUNITY"
  | "STALE_DATA"
  | "INSUFFICIENT_EDGE"
  | "INSUFFICIENT_BALANCE"
  | "RISK_REJECT"
  | "TEMPORARY_RPC_FAILURE"
  | "EXECUTION_FAILURE"
  | "TRANSACTION_UNKNOWN";

export type RetryAction = "none" | "refresh" | "requote" | "reroute";

export type FailurePolicy = {
  class: ExecutionFailureClass;
  code: TradeErrorCode;
  retry: RetryAction;
  maxRetries: number;
  backoffMs: number;
  reason: string;
};

export function failurePolicy(error: unknown): FailurePolicy {
  const classified = classifyTradeError(error);
  const base = { code: classified.code, reason: classified.message };
  switch (classified.code) {
    case "QUOTE_STALE":
      return { ...base, class: "STALE_DATA", retry: "requote", maxRetries: 1, backoffMs: 150 };
    case "LIQUIDITY_CHANGED":
    case "ROUTE_DISAPPEARED":
      return { ...base, class: "STALE_DATA", retry: "reroute", maxRetries: 1, backoffMs: 150 };
    case "QUOTE_TIMEOUT":
    case "RPC_FAILURE":
    case "API_RATE_LIMIT":
    case "VENUE_UNAVAILABLE":
      return {
        ...base,
        class: "TEMPORARY_RPC_FAILURE",
        retry: "refresh",
        maxRetries: 1,
        backoffMs: classified.code === "API_RATE_LIMIT" ? 10_000 : 400,
      };
    case "NET_EDGE_TOO_LOW":
      return { ...base, class: "INSUFFICIENT_EDGE", retry: "none", maxRetries: 0, backoffMs: 0 };
    case "INSUFFICIENT_BALANCE":
      return { ...base, class: "INSUFFICIENT_BALANCE", retry: "refresh", maxRetries: 1, backoffMs: 200 };
    case "POSITION_LIMIT":
    case "POLICY_BLOCK":
    case "PRICE_UNCERTAIN":
    case "PRICE_DEPEGGED":
    case "INSUFFICIENT_CPU":
    case "INSUFFICIENT_NET":
    case "INSUFFICIENT_RAM":
      return { ...base, class: "RISK_REJECT", retry: "none", maxRetries: 0, backoffMs: 0 };
    case "TRANSACTION_UNKNOWN":
      return { ...base, class: "TRANSACTION_UNKNOWN", retry: "none", maxRetries: 0, backoffMs: 0 };
    default:
      return { ...base, class: "EXECUTION_FAILURE", retry: "none", maxRetries: 0, backoffMs: 0 };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry only PRE-SIGN transient preparation work. Never wrap transaction
 * broadcast with this helper. UNKNOWN and execution failures are never retried.
 */
export async function withTransientPreparationRetry<T>(opts: {
  prepare: (attempt: number, action: RetryAction) => Promise<T>;
  onRetry?: (policy: FailurePolicy, attempt: number) => void | Promise<void>;
}): Promise<T> {
  let action: RetryAction = "none";
  let retryLimit = 0;
  for (let attempt = 0; attempt <= retryLimit; attempt++) {
    try {
      return await opts.prepare(attempt, action);
    } catch (err) {
      const policy = failurePolicy(err);
      retryLimit = policy.maxRetries;
      if (attempt >= retryLimit || policy.retry === "none") throw err;
      await opts.onRetry?.(policy, attempt + 1);
      if (policy.backoffMs > 0) await sleep(policy.backoffMs);
      action = policy.retry;
    }
  }
  throw new TradeError("UNKNOWN", "Preparation retry exhausted");
}
