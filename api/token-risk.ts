/**
 * POST /api/token-risk — server-side token scam / copycat screen (Vercel function).
 *
 * Body: { tokens: [{ symbol, contract, usdPrice?, tvlUsd? }] } (max 4)
 * Reply: { available: true, results: { "SYM@contract": { copycat, scam } } }
 *        or { available: false } when the service is not configured / down.
 *
 * The TypeSafe key is read from the server env var TYPESAFE_API_KEY and never
 * leaves this function (not returned, not logged). Advisory only: the result is
 * a UI warning and is never an input to trading, signing or gates.
 */
import {
  buildJevRequest,
  isKnownToken,
  parseJevResponse,
  parseTokenRiskRequest,
  tokenId,
  type TokenRisk,
} from "../src/lib/leef/token-risk-core";

declare const process: { env: Record<string, string | undefined> };

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 6 * 3600_000;
const cache = new Map<string, { at: number; risk: TokenRisk }>();

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const tokens = parseTokenRiskRequest(body);
  if (!tokens) return json({ error: "expected { tokens: [{ symbol, contract }] } (1-4 tokens)" }, 400);

  const results: Record<string, TokenRisk> = {};
  const now = Date.now();
  const todo = tokens.filter((t) => {
    if (isKnownToken(t)) return false;
    const hit = cache.get(tokenId(t));
    if (hit && now - hit.at < CACHE_TTL_MS) {
      results[tokenId(t)] = hit.risk;
      return false;
    }
    return true;
  });
  if (!todo.length) return json({ available: true, results });

  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return json({ available: false });

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildJevRequest(todo)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return json({ available: false });
    const parsed = parseJevResponse(await res.json(), todo);
    for (const [id, risk] of Object.entries(parsed)) {
      cache.set(id, { at: now, risk });
      results[id] = risk;
    }
    return json({ available: true, results });
  } catch {
    return json({ available: false });
  }
}
