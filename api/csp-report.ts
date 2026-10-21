/**
 * POST /api/csp-report — CSP violation report sink (Vercel function).
 *
 * The report-only policy in vercel.json points report-uri/report-to here so the
 * dry-run CSP starts producing telemetry before any enforcement is switched on.
 * Browsers POST `application/csp-report` (legacy report-uri) or
 * `application/reports+json` (report-to) payloads; both are accepted.
 *
 * Reports are attacker-influenceable (violated URIs come from page content), so
 * bodies are never trusted — only logged, truncated. Minimal by design: 204 +
 * console log (Vercel function logs). A durable store (KV/LogDrain filter) is a
 * follow-up. Rate-limited per IP; no auth (browsers cannot send credentials
 * with violation reports).
 */
import { guard } from "./_guard";

const MAX_LOG_CHARS = 2048;

export async function POST(request: Request): Promise<Response> {
  const blocked = guard(request, { route: "csp-report", auth: false, limit: 60 });
  if (blocked) return blocked;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Tolerate unparseable bodies — still 204 so browsers don't retry.
  }
  const serialized = JSON.stringify(body) ?? "unparseable";
  console.log("csp-report", serialized.slice(0, MAX_LOG_CHARS));
  return new Response(null, { status: 204 });
}

// Legacy report-uri implementations only ever POST; answer other methods 204
// too so health checks / probes don't generate 405 noise.
export function GET(): Response {
  return new Response(null, { status: 204 });
}
