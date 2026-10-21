/**
 * api/_guard.ts — shared first-line guard for quota-spending serverless endpoints.
 *
 * Two layers, applied in order (rate limit first, so unauthenticated floods are
 * still capped):
 *
 * 1. Fixed-window per-IP rate limit (in-memory). On serverless this is a first
 *    line of defence only: each warm instance has its own Map, so the effective
 *    ceiling is `limit × live instances`. It throttles single-instance abuse and
 *    retry storms; durable cross-instance limiting needs the KV follow-up
 *    (Vercel KV / Upstash sliding window) — tracked as a follow-up to audit LT-2.
 *
 * 2. Optional bearer auth. When the server env var TRADER_API_TOKEN is set,
 *    requests must carry `Authorization: Bearer <TRADER_API_TOKEN>`; otherwise
 *    401. When the var is UNSET the guard fails OPEN by design (the public web
 *    app calls these endpoints without credentials today) — the rate limit
 *    above still applies in that mode. Setting the token without also
 *    distributing it to first-party clients will make those clients degrade
 *    gracefully (they treat non-OK as "service unavailable").
 *
 * Never log request bodies here — callers proxy market state that can be
 * position-sensitive.
 */
declare const process: { env: Record<string, string | undefined> };

export interface GuardOptions {
  /** Bucket namespace, e.g. "token-risk" — limits are per route per IP. */
  route: string;
  /** Max requests per IP per window. Default 30. */
  limit?: number;
  /** Window length in ms. Default 60_000 (fixed window). */
  windowMs?: number;
  /** Require bearer auth when TRADER_API_TOKEN is set. Default true. */
  auth?: boolean;
}

interface Bucket {
  windowStart: number;
  count: number;
}

// Per-instance state. Module scope = shared across invocations on a warm instance.
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000; // prune rather than grow unboundedly under IP spray

const json = (body: unknown, status: number, extraHeaders?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });

function clientIp(request: Request): string {
  // Vercel sets x-forwarded-for to the client IP chain; first hop is the client.
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function prune(now: number, windowMs: number): void {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [key, b] of buckets) {
    if (now - b.windowStart >= windowMs) buckets.delete(key);
  }
  // If still oversized (all buckets hot), drop the map — a reset is cheaper
  // than unbounded memory and only briefly relaxes the limit.
  if (buckets.size >= MAX_BUCKETS) buckets.clear();
}

/** Constant-time-ish string compare (length check first, then full scan). */
function tokenEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Returns null when the request may proceed, or a ready-made 401/429 Response.
 * Fail-open applies ONLY to missing server config (no TRADER_API_TOKEN), never
 * to a presented-but-wrong token.
 */
export function guard(request: Request, opts: GuardOptions): Response | null {
  const limit = opts.limit ?? 30;
  const windowMs = opts.windowMs ?? 60_000;
  const now = Date.now();
  const key = `${opts.route}:${clientIp(request)}`;

  prune(now, windowMs);
  let b = buckets.get(key);
  if (!b || now - b.windowStart >= windowMs) {
    b = { windowStart: now, count: 0 };
    buckets.set(key, b);
  }
  if (b.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((b.windowStart + windowMs - now) / 1000));
    return json({ error: "rate limited" }, 429, { "Retry-After": String(retryAfter) });
  }
  b.count += 1;

  if (opts.auth !== false) {
    const expected = process.env.TRADER_API_TOKEN;
    if (expected) {
      const presented = request.headers.get("authorization") ?? "";
      const match = presented.startsWith("Bearer ") && tokenEquals(presented.slice(7), expected);
      if (!match) return json({ error: "unauthorized" }, 401);
    }
    // Token unset → fail open (documented above); rate limit still applied.
  }
  return null;
}
