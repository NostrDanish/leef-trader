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
  | "QUOTE_FAILURE"
  | "API_RATE_LIMIT"
  | "SIGNING_FAILURE"
  | "TRANSACTION_REJECTED"
  | "TRANSACTION_FAILED"
  | "TRANSACTION_UNKNOWN"
  | "POLICY_BLOCK"
  | "POSITION_LIMIT"
  | "NET_EDGE_TOO_LOW"
  | "PRICE_UNCERTAIN"
  | "PRICE_DEPEGGED"
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

/** Pull the real contract assert from an Antelope HTTP 500 body. */
export function chainAssertMessage(raw: string): string | null {
  // Deepest first: error.details[].message holds the contract's assert text.
  const detail = raw.match(/"details"\s*:\s*\[\s*\{[^{}]*?"message"\s*:\s*"([^"]{2,300})"/);
  const any = raw.match(/"message"\s*:\s*"([^"]{2,300})"/g);
  let picked = detail?.[1] ?? null;
  if (!picked && any && any.length > 0) {
    picked = any[any.length - 1]!.replace(/^"message"\s*:\s*"/, "").replace(/"$/, "");
  }
  if (!picked) return null;
  const text = picked
    .replace(/\\"/g, '"')
    .replace(/^assertion failure with message:?\s*/i, "")
    .trim();
  if (!text || /internal service error/i.test(text)) return null;
  return text;
}

export function classifyTradeError(err: unknown): { code: TradeErrorCode; message: string } {
  if (err instanceof TradeError) return { code: err.code, message: err.message };
  const msg = err instanceof Error ? err.message : "Trade failed";
  const assert = chainAssertMessage(msg);
  const shown = assert ? assert : msg;
  const m = shown.toLowerCase();

  // Context-aware source detection (from FetchContext labels injected by fetchJson).
  const isAlcorQuote = /alcor router|alcor quote|swaprouter/.test(m);
  const isWaxRpc = /wax rpc|push_transaction|get_table_rows|get_info|chain info|broadcast to/.test(m);
  const isHyperion = /hyperion|history\/get_transaction|get_tokens/.test(m);
  const isVenue = /alcor|defibox|taco|venue/.test(m);
  const isHttp5xx = /\bhttp 5\d\d\b/.test(m) || /\bstatus=5\d\d\b/.test(m);

  if (/invalid amount|invalid quantity|quantity must/.test(m)) {
    return { code: "MIN_OUT_FAILED", message: shown };
  }
  if (/eosio_assert|assertion failure|3050003/.test(msg.toLowerCase())) {
    return { code: "TRANSACTION_REJECTED", message: shown };
  }
  if (/\b429\b/.test(msg) || /rate limit/.test(m)) return { code: "API_RATE_LIMIT", message: shown };
  if (/timeout|timed out|aborted/.test(m)) return { code: "QUOTE_TIMEOUT", message: shown };
  if (/stale quote|quote is .* old/.test(m)) return { code: "QUOTE_STALE", message: shown };
  if (/no usable route|no backed route|no executable|no trading route|route disappeared/.test(m)) {
    return { code: "ROUTE_DISAPPEARED", message: shown };
  }
  if (/min.?out|minimum output|overdrawn/.test(m)) return { code: "MIN_OUT_FAILED", message: shown };
  if (/slippage/.test(m)) return { code: "SLIPPAGE_TOO_HIGH", message: shown };
  if (/insufficient (cpu|net|ram)/.test(m) || /cpu .*used/.test(m)) {
    if (/net/.test(m)) return { code: "INSUFFICIENT_NET", message: shown };
    if (/ram/.test(m)) return { code: "INSUFFICIENT_RAM", message: shown };
    return { code: "INSUFFICIENT_CPU", message: shown };
  }
  if (/balance|overdrawn|no .* in this wallet|need \d|insufficient.*balance/.test(m)) {
    return { code: "INSUFFICIENT_BALANCE", message: shown };
  }
  if (/policy|not allowlisted|foreign receiver/.test(m)) return { code: "POLICY_BLOCK", message: shown };
  if (/position cap|max position|remaining room/.test(m)) return { code: "POSITION_LIMIT", message: shown };
  if (/depegged|stable.*deviation/.test(m)) return { code: "PRICE_DEPEGGED", message: shown };
  if (/price uncertain|price confidence|authoritative usd price|price is stale/.test(m)) {
    return { code: "PRICE_UNCERTAIN", message: shown };
  }
  if (/net edge/.test(m)) return { code: "NET_EDGE_TOO_LOW", message: shown };
  if (/model.only|fresh executable/.test(m)) return { code: "MODEL_ONLY", message: shown };
  if (/unknown/.test(m) && /tx|transaction/.test(m)) return { code: "TRANSACTION_UNKNOWN", message: shown };
  if (/reject/.test(m)) return { code: "TRANSACTION_REJECTED", message: shown };
  if (/sign/.test(m)) return { code: "SIGNING_FAILURE", message: shown };
  if (/failed on-chain|transaction failed/.test(m)) return { code: "TRANSACTION_FAILED", message: shown };

  // A plain HTTP 500/502/503 with a host label points to the right subsystem.
  if (isHttp5xx || /\b5\d\d\b/.test(msg)) {
    if (isAlcorQuote) return { code: "QUOTE_FAILURE", message: shown };
    if (isWaxRpc || isHyperion) return { code: "RPC_FAILURE", message: shown };
    if (isVenue) return { code: "VENUE_UNAVAILABLE", message: shown };
  }

  if (/rpc|chain info|broadcast/.test(m)) return { code: "RPC_FAILURE", message: shown };
  if (/alcor|defibox|taco|venue/.test(m)) return { code: "VENUE_UNAVAILABLE", message: shown };
  return { code: "UNKNOWN", message: shown };
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
    case "PRICE_UNCERTAIN":
      return "Price uncertain";
    case "PRICE_DEPEGGED":
      return "Stablecoin depegged";
    case "TRANSACTION_UNKNOWN":
      return "Tx unconfirmed";
    case "TRANSACTION_FAILED":
      return "Tx failed";
    case "MODEL_ONLY":
      return "Venue not executable";
    case "QUOTE_FAILURE":
      return "Quote failed";
    case "RPC_FAILURE":
      return "RPC failure";
    default:
      return "Trade failed";
  }
}
