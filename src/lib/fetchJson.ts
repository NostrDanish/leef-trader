/**
 * Browser-side JSON fetch with automatic CORS-proxy fallback.
 *
 * Some public endpoints (the Alcor API, some WAX RPC nodes) don't send
 * permissive CORS headers, so a direct browser call fails even though the
 * URL is reachable. We try direct first, then retry through the Shakespeare
 * CORS proxy. Once a host has failed direct (CORS block surfaces as a
 * TypeError), subsequent calls go straight to the proxy to avoid doubling
 * every request.
 */
const CORS_PROXY = "https://proxy.shakespeare.diy/?url=";

export class FetchJsonError extends Error {}

const proxyHosts = new Set<string>();

async function attempt(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new FetchJsonError(`HTTP ${res.status}: ${text.slice(0, 180)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new FetchJsonError(`Invalid JSON from ${new URL(url).hostname}`);
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
  } = {},
): Promise<unknown> {
  const { method = "GET", body, timeoutMs = 15_000, directOnly = false } = opts;
  const init: RequestInit = {
    method,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };

  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  })();
  const proxied = `${CORS_PROXY}${encodeURIComponent(url)}`;

  if (!directOnly && host && proxyHosts.has(host)) {
    return await attempt(proxied, init, timeoutMs);
  }

  try {
    return await attempt(url, init, timeoutMs);
  } catch (err) {
    if (directOnly) throw err;
    if (host) proxyHosts.add(host);
    return await attempt(proxied, init, timeoutMs);
  }
}
