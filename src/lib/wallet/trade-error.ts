/**
 * Classified execution failures. Generic "Trade failed" hides the reason
 * we need to fix the next attempt. The code is the machine-readable id;
 * message is what the journal and toast show.
 */
export type TradeErrorCode =
  | "QUOTE_TIMEOUT"
  | "QUOTE_STALE"
  | "ROUTE_DISAPPEARED"
  | "LIQUIDITY_CHANGED"
  | "SLIPPAGE_TOO_HIGH"
  | "MIN_OUT_FAILED"
  | "INSUFFICIENT_BALANCE"
  | "INSUFFICIENT_CPU"
  | "INSUFFICIENT_NET"
  | "INSUFFICIENT_RAM"
  | "RPC_FAILURE"
  | "API_RATE_LIMIT"
  | "SIGNING_FAILURE"
  | "TRANSACTION_REJECTED"
  | "TRANSACTION_FAILED"
  | "TRANSACTION_UNKNOWN"
  | "POLICY_BLOCK"
  | "POSITION_LIMIT"
  | "NET_EDGE_TOO_LOW"
  | "VENUE_UNAVAILABLE"
  | "MODEL_ONLY"
  | "UNKNOWN";

export class TradeError extends Error {
  readonly code: TradeErrorCode;
  constructor(code: TradeErrorCode, message: string) {
    super(message);
    this.name = "TradeError";
    this.code = code;
  }
}

export function classifyTradeError(err: unknown): { code: TradeErrorCode; message: string } {
  if (err instanceof TradeError) return { code: err.code, message: err.message };
  const msg = err instanceof Error ? err.message : "Trade failed";
  const m = msg.toLowerCase();
  if (/\b429\b/.test(msg) || /rate limit/.test(m)) return { code: "API_RATE_LIMIT", message: msg };
  if (/timeout|timed out|aborted/.test(m)) return { code: "QUOTE_TIMEOUT", message: msg };
  if (/stale quote|quote is .* old/.test(m)) return { code: "QUOTE_STALE", message: msg };
  if (/no usable route|no backed route|no executable/.test(m)) return { code: "ROUTE_DISAPPEARED", message: msg };
  if (/min.?out|minimum output|overdrawn/.test(m)) return { code: "MIN_OUT_FAILED", message: msg };
  if (/slippage/.test(m)) return { code: "SLIPPAGE_TOO_HIGH", message: msg };
  if (/insufficient (cpu|net|ram)/.test(m) || /cpu .*used/.test(m)) {
    if (/net/.test(m)) return { code: "INSUFFICIENT_NET", message: msg };
    if (/ram/.test(m)) return { code: "INSUFFICIENT_RAM", message: msg };
    return { code: "INSUFFICIENT_CPU", message: msg };
  }
  if (/balance|overdrawn|no .* in this wallet|need \d/.test(m)) {
    return { code: "INSUFFICIENT_BALANCE", message: msg };
  }
  if (/policy|not allowlisted|foreign receiver/.test(m)) return { code: "POLICY_BLOCK", message: msg };
  if (/position cap|max position|remaining room/.test(m)) return { code: "POSITION_LIMIT", message: msg };
  if (/net edge/.test(m)) return { code: "NET_EDGE_TOO_LOW", message: msg };
  if (/model.only|fresh executable/.test(m)) return { code: "MODEL_ONLY", message: msg };
  if (/unknown/.test(m) && /tx|transaction/.test(m)) return { code: "TRANSACTION_UNKNOWN", message: msg };
  if (/reject/.test(m)) return { code: "TRANSACTION_REJECTED", message: msg };
  if (/sign/.test(m)) return { code: "SIGNING_FAILURE", message: msg };
  if (/rpc|chain info|broadcast/.test(m)) return { code: "RPC_FAILURE", message: msg };
  if (/failed on-chain|transaction failed/.test(m)) return { code: "TRANSACTION_FAILED", message: msg };
  if (/alcor|defibox|taco|venue/.test(m)) return { code: "VENUE_UNAVAILABLE", message: msg };
  return { code: "UNKNOWN", message: msg };
}

export function toastTitleFor(code: TradeErrorCode): string {
  switch (code) {
    case "QUOTE_TIMEOUT":
      return "Quote timed out";
    case "QUOTE_STALE":
      return "Quote went stale";
    case "ROUTE_DISAPPEARED":
      return "Route disappeared";
    case "MIN_OUT_FAILED":
      return "Min-out rejected";
    case "INSUFFICIENT_CPU":
    case "INSUFFICIENT_NET":
    case "INSUFFICIENT_RAM":
      return "WAX resources";
    case "INSUFFICIENT_BALANCE":
      return "Insufficient balance";
    case "API_RATE_LIMIT":
      return "Rate limited";
    case "POLICY_BLOCK":
      return "Policy blocked";
    case "POSITION_LIMIT":
      return "Position limit";
    case "NET_EDGE_TOO_LOW":
      return "No net edge";
    case "TRANSACTION_UNKNOWN":
      return "Tx unconfirmed";
    case "TRANSACTION_FAILED":
      return "Tx failed";
    case "MODEL_ONLY":
      return "Venue not executable";
    default:
      return "Trade failed";
  }
}
