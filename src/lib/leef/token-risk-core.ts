/**
 * Token scam / copycat screening with TypeSafe Jev — pure, shared core.
 *
 * Used by the server-side function `api/token-risk.ts` (which alone holds
 * the TypeSafe key) and by the client to interpret its answer. Nothing here
 * talks to the network or knows a secret.
 *
 * HARD INVARIANT: this is an ADVISORY warning shown before a user swaps. It is
 * never an input to the trade path (engine, gates, signer, policy firewall),
 * it never enables, sizes or authorizes a trade, and when the service is
 * unavailable the UI simply shows nothing (deterministic behaviour unchanged).
 */

export type TokenRiskInput = {
  symbol: string;
  contract: string;
  /** Optional market context (helps the judgment, never required). */
  usdPrice?: number;
  tvlUsd?: number;
};

export type TokenRisk = {
  /** Probability the token impersonates a well-known token (0..1). */
  copycat: number;
  /** Probability the metadata shows a scam / honeypot / rug pattern (0..1). */
  scam: number;
};

export type TokenRiskLevel = "ok" | "caution" | "warning";

/** Well-known WAX tokens, identified by SYMBOL@contract. Never flagged. */
export const KNOWN_TOKENS: readonly string[] = [
  "WAX@eosio.token",
  "LEEF@leefmaincorp",
  "USDT@usdt.alcor",
  "WAXUSDT@eth.token",
  "WAXUSDC@eth.token",
  "USDC@wrap.alcor",
  "USDT@wrap.alcor",
  "PARAUSD@parareserves",
  "TLM@alien.worlds",
  "WAXWBTC@eth.token",
  "WAXWETH@eth.token",
  "WAXDAO@token.waxdao",
  "LSWAX@token.fusion",
  "NEFTY@token.nefty",
];

/** Show a hard warning at/above this probability; a softer caution above CAUTION. */
export const WARNING_THRESHOLD = 0.7;
export const CAUTION_THRESHOLD = 0.5;
export const MAX_TOKENS_PER_REQUEST = 4;

export const tokenId = (t: Pick<TokenRiskInput, "symbol" | "contract">): string =>
  `${t.symbol.toUpperCase()}@${t.contract.toLowerCase()}`;

export const isKnownToken = (t: Pick<TokenRiskInput, "symbol" | "contract">): boolean =>
  KNOWN_TOKENS.includes(tokenId(t));

const SYMBOL_RE = /^[A-Z]{1,7}$/;
const CONTRACT_RE = /^[a-z1-5.]{1,12}$/;

/** Validate untrusted request input; returns the clean list or null. */
export function parseTokenRiskRequest(body: unknown): TokenRiskInput[] | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { tokens?: unknown }).tokens;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TOKENS_PER_REQUEST) return null;
  const out: TokenRiskInput[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const { symbol, contract, usdPrice, tvlUsd } = r as Record<string, unknown>;
    if (typeof symbol !== "string" || typeof contract !== "string") return null;
    const s = symbol.toUpperCase(), c = contract.toLowerCase();
    if (!SYMBOL_RE.test(s) || !CONTRACT_RE.test(c)) return null;
    const t: TokenRiskInput = { symbol: s, contract: c };
    if (typeof usdPrice === "number" && Number.isFinite(usdPrice) && usdPrice >= 0) t.usdPrice = usdPrice;
    if (typeof tvlUsd === "number" && Number.isFinite(tvlUsd) && tvlUsd >= 0) t.tvlUsd = tvlUsd;
    out.push(t);
  }
  return out;
}

/** Build the System One request: one state, two Noul questions per token, one call. */
export function buildJevRequest(tokens: readonly TokenRiskInput[], model = "jev-latest") {
  const candidates: Record<string, unknown> = {};
  const questions: Record<string, unknown> = {};
  tokens.forEach((t, i) => {
    const k = `t${i}`;
    candidates[k] = { token_id: tokenId(t), symbol: t.symbol, contract: t.contract, usd_price: t.usdPrice, pool_tvl_usd: t.tvlUsd };
    questions[`${k}_copycat`] = {
      type: "noul",
      instructions: `Is the token in \`candidates.${k}\` likely a copycat or impersonation of one of the well-known tokens in \`known_tokens\`? A WAX token is identified by symbol AND contract; a same or confusingly similar symbol, or a contract name mimicking the real issuer, on a DIFFERENT contract is impersonation. Distinct projects with their own names are not copycats.`,
      criteria: { true: "Likely impersonates a known token", false: "Its own distinct token, or the genuine token" },
    };
    questions[`${k}_scam`] = {
      type: "noul",
      instructions: `Based only on the metadata in \`candidates.${k}\`, does this token show a likely scam / honeypot / rug-pull pattern (deceptive naming promising value or stability it does not have, impersonation, tiny-liquidity bait)? Ordinary small game or community tokens are not scams.`,
      criteria: { true: "Likely scam, honeypot or rug pattern", false: "No meaningful scam signal" },
    };
  });
  return { model, state: { chain: "WAX (Antelope)", known_tokens: KNOWN_TOKENS, candidates }, questions };
}

const noul = (a: unknown): number | null => {
  if (!a || typeof a !== "object") return null;
  const v = (a as { type?: unknown; noul?: unknown });
  return v.type === "noul" && typeof v.noul === "number" && v.noul >= 0 && v.noul <= 1 ? v.noul : null;
};

/** Map a System One response back to token ids. Malformed answers are dropped (fail-open). */
export function parseJevResponse(json: unknown, tokens: readonly TokenRiskInput[]): Record<string, TokenRisk> {
  const answers = (json && typeof json === "object" ? (json as { answers?: unknown }).answers : null) as Record<string, unknown> | null;
  const out: Record<string, TokenRisk> = {};
  if (!answers || typeof answers !== "object") return out;
  tokens.forEach((t, i) => {
    const copycat = noul(answers[`t${i}_copycat`]), scam = noul(answers[`t${i}_scam`]);
    if (copycat !== null && scam !== null) out[tokenId(t)] = { copycat, scam };
  });
  return out;
}

export function riskLevel(r: TokenRisk | null | undefined): TokenRiskLevel {
  if (!r) return "ok";
  const p = Math.max(r.copycat, r.scam);
  return p >= WARNING_THRESHOLD ? "warning" : p >= CAUTION_THRESHOLD ? "caution" : "ok";
}
