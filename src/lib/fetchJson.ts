/**
 * Browser-side JSON fetch with CORS-proxy fallback, per-host concurrency
 * limits, and 429 backoff.
 *
 * - Direct first; only NETWORK failures (CORS blocks surface as TypeError)
 *   on idempotent GETs retry through the Shakespeare proxy. HTTP errors
 *   (4xx/5xx) are real answers from the host — proxying them would just
 *   double the load. Non-GET requests are NEVER proxied: a failed POST
 *   (worst case push_transaction) re-submitted through a third party would
 *   expose the signed payload and silently double-submit a timed-out
 *   broadcast — the "exactly one submission" invariant forbids it.
 * - At most 4 in-flight requests per host; the rest queue. Unthrottled bursts
 *   (e.g. 80 pool refreshes at once) are what trip nginx rate limits.
 * - On 429/503 the host gets a cooldown and the caller retries once after it.
 */
const CORS_PROXY = "https://proxy.shakespeare.diy/?url=";

export class FetchJsonError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly context?: FetchContext,
  ) {
    super(message);
  }
}

/**
 * Structured context for every external fetch. The UI/debug log needs to know
 * WHO was called, WHAT was requested, and HOW it answered — not a bare
 * "HTTP 500: Internal error" that forces the user to guess.
 */
export type FetchContext = {
  /** Human-readable operation, e.g. "Alcor router quote". */
  operation: string;
  /** Endpoint URL (without query secrets). */
  endpoint: string;
  /** Parameters / body summary. */
  params?: Record<string, unknown>;
  /** HTTP status, if one was returned. */
  status?: number;
  /** Response body fragment. */
  body?: string;
};

function contextMessage(ctx: FetchContext): string {
  const params = ctx.params
    ? Object.entries(ctx.params)
        .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
        .join(" ")
    : "";
  return [
    ctx.operation,
    ctx.endpoint,
    params,
    ctx.status != null ? `status=${ctx.status}` : "",
    ctx.body ? `body=${ctx.body.slice(0, 200)}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

export function fetchErrorMessage(ctx: FetchContext): string {
  return contextMessage(ctx);
}

const proxyHosts = new Set<string>();

export type FetchPriority = "high" | "medium" | "low";

const PRIORITY_RANK: Record<FetchPriority, number> = { high: 0, medium: 1, low: 2 };

type Waiter = { resolve: () => void; priority: FetchPriority; signal?: AbortSignal };

export type FetchTiming = {
  url: string;
  priority: FetchPriority;
  queueWaitMs: number;
  networkMs: number;
  parseMs: number;
  totalMs: number;
  status: number | null;
};

let lastTiming: FetchTiming | null = null;
export function lastFetchTiming(): FetchTiming | null {
  return lastTiming;
}

/** host → in-flight count + waiters */
const hostLoad = new Map<string, { inFlight: number; queue: Waiter[] }>();
/** host → unix ms until requests may resume (set on 429/503). */
const hostCooldown = new Map<string, number>();

const MAX_PER_HOST = 4;
/** Reserve one slot so HIGH execution quotes are never starved by analytics. */
const HIGH_RESERVED = 1;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function takeNext(queue: Waiter[], inFlight: number): Waiter | undefined {
  if (queue.length === 0) return undefined;
  // Cancelled/obsolete market requests leave the queue before consuming a
  // network slot. This is especially important for LOW discovery work.
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i]!.signal?.aborted) queue.splice(i, 1);
  }
  const highOnly = inFlight >= MAX_PER_HOST - HIGH_RESERVED;
  let bestI = -1;
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!.priority;
    if (highOnly && p !== "high") continue;
    if (bestI < 0 || PRIORITY_RANK[p] < PRIORITY_RANK[queue[bestI]!.priority]) bestI = i;
  }
  if (bestI < 0) return undefined;
  return queue.splice(bestI, 1)[0];
}

async function acquire(
  host: string,
  priority: FetchPriority,
  signal?: AbortSignal,
): Promise<() => void> {
  if (signal?.aborted) throw new DOMException("Request cancelled before queue", "AbortError");
  if (!host) return () => undefined;
  let entry = hostLoad.get(host);
  if (!entry) {
    entry = { inFlight: 0, queue: [] };
    hostLoad.set(host, entry);
  }
  const canGo = () => {
    if (entry!.inFlight < MAX_PER_HOST - HIGH_RESERVED) return true;
    if (entry!.inFlight < MAX_PER_HOST && priority === "high") return true;
    return false;
  };
  if (!canGo()) {
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, priority, signal };
      entry!.queue.push(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          const i = entry!.queue.indexOf(waiter);
          if (i >= 0) entry!.queue.splice(i, 1);
          reject(new DOMException("Queued request cancelled", "AbortError"));
        },
        { once: true },
      );
    });
  }
  if (signal?.aborted) throw new DOMException("Queued request cancelled", "AbortError");
  entry.inFlight += 1;
  return () => {
    entry!.inFlight -= 1;
    const next = takeNext(entry!.queue, entry!.inFlight);
    if (next) next.resolve();
  };
}

async function cooldownWait(host: string): Promise<void> {
  if (!host) return;
  const until = hostCooldown.get(host);
  if (!until) return;
  const wait = until - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function withTimeout(user: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  if (!user) return t;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([user, t]);
  return user.aborted ? user : t;
}

async function attempt(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  ctx?: FetchContext,
): Promise<{ value: unknown; networkMs: number; parseMs: number; status: number }> {
  const networkAt = performance.now();
  const res = await fetch(url, {
    ...init,
    signal: withTimeout(init.signal ?? undefined, timeoutMs),
  });
  const text = await res.text();
  const networkMs = performance.now() - networkAt;
  const fullCtx: FetchContext = {
    operation: ctx?.operation ?? "fetch",
    endpoint: url.split("?")[0]!,
    params: ctx?.params,
    status: res.status,
    body: text.slice(0, 400),
  };
  if (!res.ok) {
    // Keep enough of the body to expose Antelope eosio_assert details[].message
    // (a 180-char slice cut the real contract assert off entirely).
    const bodyPreview = text.slice(0, 600);
    const msg = ctx
      ? `${contextMessage(fullCtx)} | HTTP ${res.status}: ${bodyPreview}`
      : `HTTP ${res.status}: ${bodyPreview}`;
    throw new FetchJsonError(msg, res.status, fullCtx);
  }
  if (!text) return { value: null, networkMs, parseMs: 0, status: res.status };
  const parseAt = performance.now();
  try {
    const value: unknown = JSON.parse(text);
    return {
      value,
      networkMs,
      parseMs: performance.now() - parseAt,
      status: res.status,
    };
  } catch {
    const msg = ctx
      ? `${contextMessage(fullCtx)} | Invalid JSON from ${new URL(url).hostname}`
      : `Invalid JSON from ${new URL(url).hostname}`;
    throw new FetchJsonError(msg, res.status, fullCtx);
  }
}

async function callHost(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  priority: FetchPriority,
  ctx?: FetchContext,
): Promise<unknown> {
  const totalAt = performance.now();
  const host = hostOf(url);
  await cooldownWait(host);
  const queueAt = performance.now();
  const release = await acquire(host, priority, init.signal ?? undefined);
  const queueWaitMs = performance.now() - queueAt;
  try {
    const result = await attempt(url, init, timeoutMs, ctx);
    lastTiming = {
      url,
      priority,
      queueWaitMs,
      networkMs: result.networkMs,
      parseMs: result.parseMs,
      totalMs: performance.now() - totalAt,
      status: result.status,
    };
    return result.value;
  } catch (err) {
    const status = err instanceof FetchJsonError ? err.status : undefined;
    if (status === 429 || status === 503) {
      // Back off the whole host with jitter; bursts cluster otherwise.
      const retryable = (hostCooldown.get(host) ?? 0) < Date.now() + 5_000;
      hostCooldown.set(host, Date.now() + 10_000 + Math.random() * 5_000);
      if (retryable) {
        await cooldownWait(host);
        const retry = await attempt(url, init, timeoutMs, ctx);
        lastTiming = {
          url,
          priority,
          queueWaitMs,
          networkMs: retry.networkMs,
          parseMs: retry.parseMs,
          totalMs: performance.now() - totalAt,
          status: retry.status,
        };
        return retry.value;
      }
    }
    throw err;
  } finally {
    release();
  }
}

export async function fetchJson(
  url: string,
  opts: {
    method?: "GET" | "POST";
    body?: unknown;
    timeoutMs?: number;
    /** Skip the proxy retry (default false). */
    directOnly?: boolean;
    /**
     * HIGH = execution / fresh quote / critical pool state.
     * MEDIUM = strategy market data.
     * LOW = analytics / history / background discovery.
     */
    priority?: FetchPriority;
    signal?: AbortSignal;
    /** Human-readable context so failures name the operation, endpoint and inputs. */
    context?: FetchContext;
  } = {},
): Promise<unknown> {
  const {
    method = "GET",
    body,
    timeoutMs = 15_000,
    directOnly = false,
    priority = "medium",
    context,
  } = opts;
  const init: RequestInit = {
    method,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  const host = hostOf(url);
  const proxied = `${CORS_PROXY}${encodeURIComponent(url)}`;
  // Non-GET requests are never proxied: re-submitting a failed POST through a
  // third party would expose the signed payload and could double-submit a
  // timed-out broadcast (the "exactly one submission" invariant).
  const proxyable = !directOnly && method === "GET";

  if (proxyable && host && proxyHosts.has(host)) {
    return await callHost(proxied, init, timeoutMs, priority, context);
  }

  try {
    return await callHost(url, init, timeoutMs, priority, context);
  } catch (err) {
    // Only network/CORS failures (TypeError) get the proxy — HTTP errors are
    // real responses and must not be duplicated.
    if (!proxyable || err instanceof FetchJsonError) throw err;
    if (host) proxyHosts.add(host);
    return await callHost(proxied, init, timeoutMs, priority, context);
  }
}
