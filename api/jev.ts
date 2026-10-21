/**
 * POST /api/jev — server-side Jev (TypeSafe System One) proxy (Vercel function).
 *
 * Body: { state: object, questions: { <qid>: typed question } }
 * Reply: { model, answers } passed through from upstream, or { available: false }
 *        when the service is not configured / down. 422 validation detail is
 *        passed through so the client can fix its request shape.
 *
 * The TypeSafe key is read from the server env var TYPESAFE_API_KEY and never
 * leaves this function (not returned, not logged). Request bodies and answers
 * are never logged either — market state can be position-sensitive.
 */
declare const process: { env: Record<string, string | undefined> };

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const TIMEOUT_MS = 30_000;
const MAX_QUESTIONS = 64;
const MAX_BODY_BYTES = 65_536;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const QUESTION_TYPES = new Set(["noul", "choice", "score"]);

function questionsOk(raw: unknown): raw is Record<string, { type: string }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_QUESTIONS) return false;
  return entries.every(
    ([qid, q]) =>
      qid.length > 0 &&
      qid.length <= 128 &&
      !!q &&
      typeof q === "object" &&
      typeof (q as { type?: unknown }).type === "string" &&
      QUESTION_TYPES.has((q as { type: string }).type),
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  if (JSON.stringify(body ?? null).length > MAX_BODY_BYTES) {
    return json({ error: "body too large (64KB cap)" }, 413);
  }
  const b = body as { state?: unknown; questions?: unknown };
  if (!b || typeof b !== "object" || !b.state || typeof b.state !== "object" || Array.isArray(b.state)) {
    return json({ error: "expected { state: object, questions: {...} }" }, 400);
  }
  if (!questionsOk(b.questions)) {
    return json({ error: `expected 1-${MAX_QUESTIONS} typed questions keyed by qid` }, 400);
  }

  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return json({ available: false }, 503);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, state: b.state, questions: b.questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 422) {
      // Validation detail is safe to pass through (no key, no secrets).
      const detail = await res.json().catch(() => null);
      return json({ error: "upstream validation failed", detail }, 422);
    }
    if (!res.ok) return json({ available: false }, 502);
    const data = (await res.json()) as { model?: unknown; answers?: unknown };
    if (!data || typeof data !== "object" || !data.answers || typeof data.answers !== "object") {
      return json({ available: false }, 502);
    }
    return json({ model: typeof data.model === "string" ? data.model : MODEL, answers: data.answers });
  } catch {
    return json({ available: false }, 502);
  }
}
