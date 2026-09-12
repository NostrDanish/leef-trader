/**
 * Browser-side JSON fetch with CORS-proxy fallback, per-host concurrency
 * limits, and 429 backoff.
 *
 * - Direct first; only NETWORK failures (CORS blocks surface as TypeError)
 *   retry through the Shakespeare proxy. HTTP errors (4xx/5xx) are real
 *   answers from the host — proxying them would just double the load.
 * - At most 4 in-flight requests per host; the rest queue. Unthrottled bursts
 *   (e.g. 80 pool refreshes at once) are what trip nginx rate limits.
 * - On 429/503 the host gets a cooldown and the caller retries once after it.
 */
const CORS_PROXY = "https://proxy.shakespeare.diy/?url=";

export class FetchJsonError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const proxyHosts = new Set<string>();

export type FetchPriority = "high" | "medium" | "low";

const PRIORITY_RANK: Record<FetchPriority, number> = { high: 0, medium: 1, low: 2 };

type Waiter = { resolve: () => void; priority: FetchPriority };

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
  // When the host is nearly full, only HIGH may take the reserved slot.
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

async function acquire(host: string, priority: FetchPriority): Promise<() => void> {
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
    await new Promise<void>((resolve) => entry!.queue.push({ resolve, priority }));
  }
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

async function attempt(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    signal: withTimeout(init.signal ?? undefined, timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new FetchJsonError(`HTTP ${res.status}: ${text.slice(0, 180)}`, res.status);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new FetchJsonError(`Invalid JSON from ${new URL(url).hostname}`);
  }
}

async function callHost(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  priority: FetchPriority,
): Promise<unknown> {
  const host = hostOf(url);
  await cooldownWait(host);
  const release = await acquire(host, priority);
  try {
    return await attempt(url, init, timeoutMs);
  } catch (err) {
    const status = err instanceof FetchJsonError ? err.status : undefined;
    if (status === 429 || status === 503) {
      // Back off the whole host with jitter; bursts cluster otherwise.
      const retryable = (hostCooldown.get(host) ?? 0) < Date.now() + 5_000;
      hostCooldown.set(host, Date.now() + 10_000 + Math.random() * 5_000);
      if (retryable) {
        await cooldownWait(host);
        return await attempt(url, init, timeoutMs);
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
  } = {},
): Promise<unknown> {
  const { method = "GET", body, timeoutMs = 15_000, directOnly = false, priority = "medium" } = opts;
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

  if (!directOnly && host && proxyHosts.has(host)) {
    return await callHost(proxied, init, timeoutMs, priority);
  }

  try {
    return await callHost(url, init, timeoutMs, priority);
  } catch (err) {
    // Only network/CORS failures (TypeError) get the proxy — HTTP errors are
    // real responses and must not be duplicated.
    if (directOnly || err instanceof FetchJsonError) throw err;
    if (host) proxyHosts.add(host);
    return await callHost(proxied, init, timeoutMs, priority);
  }
}
