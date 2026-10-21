/**
 * Jev (TypeSafe System One) browser client. Talks ONLY to our own serverless
 * route (/api/jev) — the TypeSafe key lives server-side and the browser never
 * reaches the upstream API directly. Every failure returns null; callers treat
 * null as "advisory unavailable" and never throw into the trading loop.
 */

export type JevQuestion =
  | { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "score"; instructions: unknown; criteria: unknown[] };

export interface JevAnswers {
  [qid: string]: {
    type: string;
    noul?: number;
    choice?: string;
    confidence?: number | null;
    probabilities?: Record<string, number>;
    score?: number;
    legend?: Record<string, unknown>;
  };
}

const ROUTE = "/api/jev";
const TIMEOUT_MS = 35_000; // server caps upstream at 30s

function answersOk(raw: unknown): raw is JevAnswers {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  for (const a of Object.values(raw as Record<string, unknown>)) {
    if (!a || typeof a !== "object" || typeof (a as { type?: unknown }).type !== "string") {
      return false;
    }
  }
  return true;
}

/** POST { state, questions } to /api/jev. null on ANY failure. */
export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
): Promise<{ answers: JevAnswers; model: string } | null> {
  try {
    const res = await fetch(ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { answers?: unknown; model?: unknown };
    if (!answersOk(data?.answers)) return null;
    return { answers: data.answers, model: typeof data.model === "string" ? data.model : "jev-latest" };
  } catch {
    return null;
  }
}
