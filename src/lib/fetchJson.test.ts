import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "./fetchJson";
import { proxyFetch } from "./wallet/session";

const PROXY_PREFIX = "https://proxy.shakespeare.diy/?url=";

function okResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Unique host per test so the module-level sticky proxyHosts set can't leak. */
let hostSeq = 0;
function freshHost(): string {
  hostSeq += 1;
  return `https://host-${hostSeq}.example.com`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchJson proxy gating", () => {
  it("never proxies a failed POST and does not mark the host sticky", async () => {
    const host = freshHost();
    const networkFail = new TypeError("Failed to fetch");
    const fetchMock = vi.fn().mockRejectedValueOnce(networkFail);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchJson(`${host}/v1/chain/push_transaction`, {
        method: "POST",
        body: { packed: "deadbeef" },
      }),
    ).rejects.toThrow("Failed to fetch");

    // No proxied retry was issued at all.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain(PROXY_PREFIX);

    // The host must not be in the sticky set: a later GET that succeeds
    // directly must go direct-first (a sticky host would proxy-first).
    fetchMock.mockResolvedValueOnce(okResponse({ ok: true }));
    await fetchJson(`${host}/v1/chain/get_info`);
    expect(String(fetchMock.mock.calls[1]![0])).toBe(`${host}/v1/chain/get_info`);
  });

  it("proxies a GET after a network failure", async () => {
    const host = freshHost();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(okResponse({ via: "proxy" }));
    vi.stubGlobal("fetch", fetchMock);

    const value = await fetchJson(`${host}/v1/chain/get_info`);
    expect(value).toEqual({ via: "proxy" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toContain(PROXY_PREFIX);
    expect(String(fetchMock.mock.calls[1]![0])).toContain(
      encodeURIComponent(`${host}/v1/chain/get_info`),
    );
  });

  it("keeps a sticky host direct for a subsequent POST", async () => {
    const host = freshHost();
    const fetchMock = vi
      .fn()
      // First: GET fails direct, succeeds via proxy → host becomes sticky.
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(okResponse({ via: "proxy" }))
      // Then: POST — must be attempted direct even though the host is sticky.
      .mockResolvedValueOnce(okResponse({ via: "direct" }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchJson(`${host}/v1/chain/get_info`);
    expect(String(fetchMock.mock.calls[1]![0])).toContain(PROXY_PREFIX);

    const value = await fetchJson(`${host}/v1/chain/get_table_rows`, {
      method: "POST",
      body: { json: true },
    });
    expect(value).toEqual({ via: "direct" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const postUrl = String(fetchMock.mock.calls[2]![0]);
    expect(postUrl).toBe(`${host}/v1/chain/get_table_rows`);
    expect(postUrl).not.toContain(PROXY_PREFIX);

    // And a failing POST to the sticky host rethrows without any proxy call.
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(
      fetchJson(`${host}/v1/chain/get_table_rows`, { method: "POST", body: {} }),
    ).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[3]![0])).not.toContain(PROXY_PREFIX);
  });
});

describe("fetchJson 429/503 retry gating (H1)", () => {
  function httpResponse(status: number, body = "rate limited"): Response {
    return new Response(body, { status });
  }

  it("a POST that gets a 429 is NOT retried — the error propagates", async () => {
    const host = freshHost();
    const fetchMock = vi.fn().mockResolvedValue(httpResponse(429));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchJson(`${host}/v1/chain/push_transaction`, {
        method: "POST",
        body: { packed: "deadbeef" },
      }),
    ).rejects.toThrow(/429/);
    // Exactly one submission — the signed payload is never re-POSTed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a POST that gets a 503 is NOT retried either", async () => {
    const host = freshHost();
    const fetchMock = vi.fn().mockResolvedValue(httpResponse(503, "edge timeout"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchJson(`${host}/v1/chain/push_transaction`, {
        method: "POST",
        body: { packed: "deadbeef" },
      }),
    ).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a bodyless GET still retries once after the 429 cooldown", async () => {
    vi.useFakeTimers();
    try {
      const host = freshHost();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(httpResponse(429))
        .mockResolvedValueOnce(okResponse({ ok: true }));
      vi.stubGlobal("fetch", fetchMock);

      const p = fetchJson(`${host}/v1/chain/get_info`);
      // The host cooldown is 10–15 s; run the clock past it.
      await vi.advanceTimersByTimeAsync(16_000);
      await expect(p).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("wallet proxyFetch", () => {
  it("refuses to proxy a push_transaction POST", async () => {
    const err = new TypeError("Failed to fetch");
    const fetchMock = vi.fn().mockRejectedValue(err);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      proxyFetch("https://wax.example.com/v1/chain/push_transaction", {
        method: "POST",
        body: JSON.stringify({ signatures: [], packed_trx: "aa" }),
      }),
    ).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain(PROXY_PREFIX);
  });

  it("proxies a bodyless GET after a network failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(okResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await proxyFetch("https://wax.example.com/v1/chain/get_info");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toContain(PROXY_PREFIX);
  });

  it("never proxies a Request-object POST, even though init is empty (L3)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("https://wax.example.com/v1/chain/push_transaction", {
      method: "POST",
      body: JSON.stringify({ signatures: [], packed_trx: "aa" }),
    });
    await expect(proxyFetch(req)).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain(PROXY_PREFIX);
  });

  it("never proxies a non-GET Request even without a body (L3)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("https://wax.example.com/v1/chain/get_info", { method: "POST" });
    await expect(proxyFetch(req)).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still proxies a bodyless GET Request object (L3)", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(okResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await proxyFetch(new Request("https://wax.example.com/v1/chain/get_info"));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toContain(PROXY_PREFIX);
  });
});
