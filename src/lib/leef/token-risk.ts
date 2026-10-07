/**
 * Client for the server-side token screen (POST /api/token-risk).
 * Advisory UI only — never imported by the trade path (see ai-boundary test).
 * Any failure resolves to null: the swap desk then simply shows no notice.
 */
import { isKnownToken, type TokenRisk, type TokenRiskInput } from "./token-risk-core";

export type TokenRiskReply = Record<string, TokenRisk>;

export async function fetchTokenRisk(tokens: TokenRiskInput[], timeoutMs = 4_000): Promise<TokenRiskReply | null> {
  const ask = tokens.filter((t) => t.contract && !isKnownToken(t)).slice(0, 4);
  if (!ask.length) return {};
  try {
    const res = await fetch("/api/token-risk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens: ask }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { available?: boolean; results?: TokenRiskReply };
    return j.available && j.results ? j.results : null;
  } catch {
    return null;
  }
}
