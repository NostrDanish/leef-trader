/**
 * AI analyst client — the LEEF Trader AI gateway (Cloudflare Worker → PPQ).
 *
 * HARD INVARIANT: the AI is an analyst, never the trading engine. This
 * module can read market/bot/evidence state and return commentary. It has
 * no path to signing, no input to the gates, and the worker itself forces
 * `"trade_authorization": false` in every response. If the gateway is down,
 * slow, or CORS-blocked, trading continues deterministically — nothing here
 * is on the trade path.
 *
 * Contract (see Leef-signer README):
 *   POST {url}/api/ai   { task, data }  → OpenAI-style chat completion,
 *   analysis JSON in choices[0].message.content (worker forces json_object)
 *   GET  {url}/api/health               → liveness
 *   Rate limit: 20 req/min per IP · 10s upstream timeout.
 */

export const DEFAULT_AI_GATEWAY = "https://leef-trader-ai.leef-trader.workers.dev";

export type AiTask =
  | "market_analysis"
  | "strategy_analysis"
  | "opportunity_explanation"
  | "post_trade_analysis"
  | "evidence_review"
  | "health_check";

export type AiFailure =
  | "unreachable_or_cors"
  | "timeout"
  | "http_error"
  | "bad_response"
  | "rate_limited_local";

export class AiError extends Error {
  readonly failure: AiFailure;
  constructor(failure: AiFailure, message: string) {
    super(message);
    this.failure = failure;
  }
}

export type AiResult = {
  /** Parsed JSON analysis from the model (shape depends on task). */
  content: unknown;
  /** Raw text before JSON.parse (kept for debugging/fallback display). */
  raw: string;
  model?: string;
  latencyMs: number;
};

/* ------------------------------------------------------------------ */
/* Client-side rate budget — stay under the worker's 20/min with margin */
/* ------------------------------------------------------------------ */

const CALLS_WINDOW_MS = 60_000;
const CALLS_MAX = 18;
const callLog: number[] = [];

export function aiBudget(): { remaining: number; resetInSec: number } {
  const now = Date.now();
  while (callLog.length && now - callLog[0]! > CALLS_WINDOW_MS) callLog.shift();
  const remaining = Math.max(0, CALLS_MAX - callLog.length);
  const resetInSec =
    callLog.length >= CALLS_MAX ? Math.ceil((CALLS_WINDOW_MS - (now - callLog[0]!)) / 1000) : 0;
  return { remaining, resetInSec };
}

/* ------------------------------------------------------------------ */
/* Calls                                                                */
/* ------------------------------------------------------------------ */

function gatewayBase(url?: string): string {
  return (url ?? DEFAULT_AI_GATEWAY).replace(/\/+$/, "");
}

/** GET /api/health — true when the gateway answers, false on any failure. */
export async function aiHealth(url?: string, timeoutMs = 6_000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${gatewayBase(url)}/api/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the analysis JSON out of an OpenAI-style (or direct-object) reply. */
export function extractContent(body: unknown): { content: unknown; raw: string; model?: string } {
  const b = body as {
    choices?: { message?: { content?: unknown } }[];
    model?: string;
    content?: unknown;
  };
  const msg = b?.choices?.[0]?.message?.content;
  const raw = typeof msg === "string" ? msg : typeof b?.content === "string" ? b.content : null;
  if (raw == null) {
    // Some gateways return the structured object directly.
    if (b && typeof b === "object" && !b.choices) return { content: b, raw: JSON.stringify(b) };
    throw new AiError("bad_response", "Gateway response had no message content");
  }
  try {
    return { content: JSON.parse(raw), raw, model: b?.model };
  } catch {
    // JSON-mode should guarantee parseable content; keep the raw text if not.
    return { content: { summary: raw }, raw, model: b?.model };
  }
}

/**
 * Pull a 1–5 token growth mix out of an analyst response. Prefers a
 * structured `targets: [{symbol, weight}]` field; falls back to scanning the
 * serialized content for candidate symbols (schema varies by model/worker
 * prompt — never trust it blindly). Returns null when nothing usable is
 * found. The caller presents the mix; a HUMAN applies it.
 */
export function extractGrowthTargets(
  content: unknown,
  candidates: string[],
): { symbol: string; weight: number }[] | null {
  const allowed = new Set(candidates.map((c) => c.toUpperCase()));
  const structured = (content as { targets?: unknown } | null)?.targets;
  if (Array.isArray(structured)) {
    const found = structured
      .map((x) => {
        const o = x as { symbol?: unknown; weight?: unknown };
        return {
          symbol: String(o?.symbol ?? "").toUpperCase(),
          weight: typeof o?.weight === "number" && Number.isFinite(o.weight) ? o.weight : 0,
        };
      })
      .filter((x) => allowed.has(x.symbol));
    if (found.length > 0) {
      const sum = found.reduce((s, x) => s + Math.max(0, x.weight), 0);
      return found.slice(0, 5).map((x) => ({
        symbol: x.symbol,
        weight: sum > 0 ? (Math.max(0, x.weight) / sum) * 100 : 100 / Math.min(found.length, 5),
      }));
    }
  }
  const text = JSON.stringify(content ?? "").toUpperCase();
  const mentioned = candidates.filter((c) => {
    const esc = c.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${esc}\\b`).test(text);
  });
  if (mentioned.length === 0) return null;
  const picked = mentioned.slice(0, 5);
  return picked.map((symbol) => ({ symbol, weight: 100 / picked.length }));
}

/**
 * Run one analyst task. `data` should be a compact JSON-serializable object
 * (the worker pairs it with its server-side system prompt). Throws AiError.
 */
export async function aiTask(
  task: AiTask,
  data: Record<string, unknown>,
  opts: { url?: string; timeoutMs?: number } = {},
): Promise<AiResult> {
  const budget = aiBudget();
  if (budget.remaining <= 0) {
    throw new AiError(
      "rate_limited_local",
      `Local rate budget exhausted — try again in ~${budget.resetInSec}s`,
    );
  }
  const ctrl = new AbortController();
  // Worker caps upstream generation at 30s (ZDR flash runs ~30–60 tok/s, so
  // a full analysis is 6–25s of pure generation). Client waits 35s. This is
  // fire-and-forget OFF the trading loop — a long analysis can never stall
  // a trade.
  const timeoutMs = opts.timeoutMs ?? 35_000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  callLog.push(t0);
  try {
    const res = await fetch(`${gatewayBase(opts.url)}/api/ai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task, data }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      throw new AiError(
        "http_error",
        `Gateway HTTP ${res.status}${text ? ` — ${text}` : ""}`,
      );
    }
    const parsed = extractContent(await res.json());
    return { ...parsed, latencyMs: Date.now() - t0 };
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new AiError("timeout", `Gateway did not answer within ${Math.round(timeoutMs / 1000)}s`);
    }
    // fetch() TypeError = DNS, offline, OR CORS-blocked. From an origin the
    // worker doesn't allowlist, this is the expected failure — say so.
    const origin = typeof location !== "undefined" ? location.origin : "this origin";
    throw new AiError(
      "unreachable_or_cors",
      `Gateway unreachable or origin not allowlisted. If this deployment's origin (${origin}) is missing from the worker's CORS list, add it in the Leef-signer dashboard and redeploy.`,
    );
  } finally {
    clearTimeout(timer);
  }
}
