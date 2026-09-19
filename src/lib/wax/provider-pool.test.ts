import { describe, expect, it, vi } from "vitest";
import { FetchJsonError } from "@/lib/fetchJson";
import type { WaxEndpoint } from "./endpoints";
import {
  BroadcastTimeoutError,
  isAmbiguousBroadcastError,
  ProviderPool,
  TRADING_MAX_BLOCK_LAG,
  tradingEligibleOf,
} from "./provider-pool";

const CHAIN_ID = "1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4";

function eps(urls: string[]): WaxEndpoint[] {
  return urls.map((url, i) => ({ url, kind: "rpc" as const, priority: i + 1, enabled: true }));
}

function infoBody(head: number) {
  return {
    chain_id: CHAIN_ID,
    head_block_num: head,
    last_irreversible_block_num: Math.max(0, head - 30),
    head_block_time: "2026-01-01T00:00:00.000",
  };
}

/** Scripted fetcher: pops one behavior per call (match → ok body | throw). */
function scriptFetcher(script: { match: string; ok?: unknown; fail?: Error }[]) {
  let i = 0;
  const seen: string[] = [];
  const fetcher = vi.fn(async (url: string) => {
    seen.push(url);
    const step = script[Math.min(i, script.length - 1)]!;
    i += 1;
    if (step.fail) throw step.fail;
    if (url.includes(step.match)) return step.ok ?? {};
    // fall through to a later matching step when the script jumps hosts
    const alt = script.slice(i).find((s) => url.includes(s.match));
    if (alt) return alt.ok ?? {};
    throw new Error(`unexpected url ${url}`);
  });
  return { fetcher, seen };
}

describe("read failover", () => {
  it("fails over to the next endpoint when the healthiest one errors", async () => {
    const { fetcher, seen } = scriptFetcher([
      { match: "a.test", fail: new Error("network down") },
      { match: "b.test", ok: { fine: true } },
    ]);
    const pool = new ProviderPool({ kind: "rpc", fetcher, endpoints: eps(["https://a.test", "https://b.test"]) });
    const res = await pool.call("/v1/chain/get_table_rows", {});
    expect(res).toEqual({ fine: true });
    expect(seen[0]).toContain("a.test");
    expect(seen[1]).toContain("b.test");
  });

  it("does NOT fail over on a definitive 4xx chain answer (eosio_assert)", async () => {
    const fetcher = vi.fn(async () => {
      throw new FetchJsonError("HTTP 500: eosio_assert", 500);
    });
    const pool = new ProviderPool({ kind: "rpc", fetcher, endpoints: eps(["https://a.test", "https://b.test"]) });
    await expect(pool.call("/v1/chain/push_transaction", {})).rejects.toThrow("eosio_assert");
    expect(fetcher).toHaveBeenCalledTimes(2); // 5xx IS a node problem → fail over
  });

  it("a 4xx is a real answer — one attempt only", async () => {
    const fetcher = vi.fn(async () => {
      throw new FetchJsonError("HTTP 400: invalid request", 400);
    });
    const pool = new ProviderPool({ kind: "rpc", fetcher, endpoints: eps(["https://a.test", "https://b.test"]) });
    await expect(pool.call("/v1/chain/get_account", {})).rejects.toThrow("HTTP 400");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps serving reads even when every endpoint is cooling down", async () => {
    // 6 failures = both endpoints enter cooldown; the 7th call (emergency
    // candidate, soonest-to-recover) succeeds.
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls <= 6) throw new Error("down");
      return infoBody(700);
    });
    const pool = new ProviderPool({ kind: "rpc", fetcher, endpoints: eps(["https://a.test", "https://b.test"]) });
    await expect(pool.call("/v1/chain/get_info", {})).rejects.toThrow("down");
    await expect(pool.call("/v1/chain/get_info", {})).rejects.toThrow("down");
    await expect(pool.call("/v1/chain/get_info", {})).rejects.toThrow("down");
    // All nodes are cooling, but the pool tries the soonest recovery instead
    // of permanently killing the market engine.
    const res = await pool.call("/v1/chain/get_info", {});
    expect((res as { head_block_num: number }).head_block_num).toBe(700);
  });
});

describe("trading eligibility (chain freshness beats speed)", () => {
  it("a node 140 blocks behind is rejected for trading even at 40ms", () => {
    expect(
      tradingEligibleOf({
        status: "healthy",
        blockLag: 140,
        chainIdOk: true,
        consecutiveFailures: 0,
        successRate: 1,
        headBlock: 100,
      }),
    ).toBe(false);
    expect(
      tradingEligibleOf({
        status: "healthy",
        blockLag: TRADING_MAX_BLOCK_LAG,
        chainIdOk: true,
        consecutiveFailures: 0,
        successRate: 1,
        headBlock: 100,
      }),
    ).toBe(true);
    expect(
      tradingEligibleOf({
        status: "healthy",
        blockLag: 0,
        chainIdOk: false, // wrong chain — hard fail
        consecutiveFailures: 0,
        successRate: 1,
        headBlock: 100,
      }),
    ).toBe(false);
  });

  it("pushTransaction targets the fresh node, not the fast-but-lagging one", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      seen.push(url);
      if (url.includes("push_transaction")) return { transaction_id: "abc" };
      if (url.includes("laggy.test")) return infoBody(100);
      return infoBody(240);
    });
    const pool = new ProviderPool({
      kind: "rpc",
      fetcher,
      endpoints: eps(["https://laggy.test", "https://fresh.test"]),
    });
    // A deliberate diagnostics health pass learns both heads.
    await pool.probeAll();

    const laggy = pool.health().find((h) => h.url.includes("laggy"))!;
    const fresh = pool.health().find((h) => h.url.includes("fresh"))!;
    expect(laggy.blockLag).toBe(140);
    expect(laggy.tradingEligible).toBe(false);
    expect(fresh.tradingEligible).toBe(true);

    const res = await pool.pushTransaction("/v1/chain/push_transaction", {
      signatures: ["SIG_K1_x"],
    });
    expect((res as { transaction_id: string }).transaction_id).toBe("abc");
    expect(seen[seen.length - 1]).toContain("fresh.test");
  });
});

describe("transaction broadcast safety", () => {
  it("a network timeout throws BroadcastTimeoutError and never resubmits", async () => {
    let submissions = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/v1/chain/get_info")) return infoBody(500);
      submissions += 1;
      throw new Error("The operation was aborted due to timeout");
    });
    const pool = new ProviderPool({ kind: "rpc", fetcher, endpoints: eps(["https://a.test", "https://b.test"]) });
    await pool.getInfo(); // prime health so a.test is trading-eligible
    await expect(
      pool.pushTransaction("/v1/chain/push_transaction", { signatures: [] }),
    ).rejects.toBeInstanceOf(BroadcastTimeoutError);
    // ONE submission. The same signed payload is never blindly re-broadcast.
    expect(submissions).toBe(1);
  });

  it("a generic network disconnect is also ambiguous and never resubmitted", async () => {
    let submissions = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/v1/chain/get_info")) return infoBody(500);
      submissions += 1;
      throw new TypeError("Failed to fetch");
    });
    const pool = new ProviderPool({ kind: "rpc", fetcher, endpoints: eps(["https://a.test", "https://b.test"]) });
    await pool.getInfo();
    await expect(
      pool.pushTransaction("/v1/chain/push_transaction", { signatures: [] }),
    ).rejects.toBeInstanceOf(BroadcastTimeoutError);
    expect(submissions).toBe(1);
  });

  /** Broadcast safety for ambiguous HTTP answers (M1). */
  const httpBroadcastCase = async (status: number, body: string) => {
    let submissions = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/v1/chain/get_info")) return infoBody(500);
      submissions += 1;
      throw new FetchJsonError(`HTTP ${status}: ${body}`, status, {
        operation: "WAX RPC push_transaction",
        endpoint: "https://a.test/v1/chain/push_transaction",
        status,
        body,
      });
    });
    const pool = new ProviderPool({ kind: "rpc", fetcher, endpoints: eps(["https://a.test", "https://b.test"]) });
    await pool.getInfo();
    const outcome = pool.pushTransaction("/v1/chain/push_transaction", { signatures: [] });
    return { outcome, submissions: () => submissions };
  };

  it("an edge-proxy 429 (no nodeos error body) is ambiguous — UNKNOWN, never a definitive failure", async () => {
    const { outcome, submissions } = await httpBroadcastCase(429, "<html>rate limited</html>");
    await expect(outcome).rejects.toBeInstanceOf(BroadcastTimeoutError);
    expect(submissions()).toBe(1);
  });

  it("an edge-proxy 503 page is ambiguous — the request may have been forwarded first", async () => {
    const { outcome, submissions } = await httpBroadcastCase(503, "503 Service Unavailable (edge)");
    await expect(outcome).rejects.toBeInstanceOf(BroadcastTimeoutError);
    expect(submissions()).toBe(1);
  });

  it("a 'duplicate transaction' 500 is ambiguous — the tx LANDED", async () => {
    const { outcome, submissions } = await httpBroadcastCase(
      500,
      '{"code":500,"message":"Internal Service Error","error":{"what":"duplicate transaction"}}',
    );
    await expect(outcome).rejects.toBeInstanceOf(BroadcastTimeoutError);
    expect(submissions()).toBe(1);
  });

  it("a real nodeos rejection (eosio_assert error body) stays a definitive failure", async () => {
    const { outcome, submissions } = await httpBroadcastCase(
      500,
      '{"code":500,"message":"Internal Service Error","error":{"code":3050003,"name":"eosio_assert_message_exception","what":"eosio_assert_message assertion failure","details":[{"message":"assertion failure with message: min out not met"}]}}',
    );
    await expect(outcome).rejects.toThrow(FetchJsonError);
    await expect(outcome).rejects.not.toBeInstanceOf(BroadcastTimeoutError);
    expect(submissions()).toBe(1);
  });

  it("isAmbiguousBroadcastError classifies bodies directly", () => {
    const mk = (status: number, body?: string) =>
      new FetchJsonError("x", status, body == null ? undefined : {
        operation: "op", endpoint: "ep", status, body,
      });
    expect(isAmbiguousBroadcastError(mk(429, "<html>edge</html>"))).toBe(true);
    expect(isAmbiguousBroadcastError(mk(503, ""))).toBe(true);
    expect(isAmbiguousBroadcastError(mk(500, '…"error":{"what":"duplicate transaction"}…'))).toBe(true);
    expect(isAmbiguousBroadcastError(mk(500, '{"code":500,"error":{"code":3050003}}'))).toBe(false);
  });
});

describe("cooldown & automatic restore", () => {
  it("cools down after 3 consecutive failures, then probes back to life", async () => {
    let failing = true;
    const fetcher = vi.fn(async () => {
      if (failing) throw new Error("down");
      return infoBody(600);
    });
    let now = 1_000_000;
    const pool = new ProviderPool({
      kind: "rpc",
      fetcher,
      clock: () => now,
      endpoints: eps(["https://a.test"]),
    });
    for (let i = 0; i < 3; i++) {
      await expect(pool.call("/v1/chain/get_info", {})).rejects.toThrow("down");
    }
    let h = pool.health()[0]!;
    expect(h.status).toBe("cooldown");
    expect(h.consecutiveFailures).toBe(3);

    failing = false;
    now += 60_000; // cooldown expires
    const probed = await pool.probe();
    expect(probed).toBe(true);
    h = pool.health()[0]!;
    expect(h.status).not.toBe("cooldown");
    expect(h.consecutiveFailures).toBe(0);
    // A couple of clean reads pump the success EWMA back over the trading bar.
    await pool.call("/v1/chain/get_info", {});
    await pool.call("/v1/chain/get_info", {});
    h = pool.health()[0]!;
    expect(h.tradingEligible).toBe(true);
  });

  it("learns head block + chain id from get_info responses", async () => {
    const { fetcher } = scriptFetcher([{ match: "a.test", ok: infoBody(449_565_202) }]);
    const pool = new ProviderPool({ kind: "rpc", fetcher, endpoints: eps(["https://a.test"]) });
    await pool.getInfo();
    const h = pool.health()[0]!;
    expect(h.headBlock).toBe(449_565_202);
    expect(h.chainIdOk).toBe(true);
  });

  it("rejects a wrong-chain endpoint and fails over to WAX immediately", async () => {
    let calls = 0;
    const fetcher = vi.fn(async (url: string) => {
      calls += 1;
      if (url.includes("wrong.test")) {
        return {
          chain_id: "0".repeat(64),
          head_block_num: 100,
          last_irreversible_block_num: 70,
          head_block_time: "x",
        };
      }
      return infoBody(101);
    });
    const pool = new ProviderPool({
      kind: "rpc",
      fetcher,
      endpoints: eps(["https://wrong.test", "https://wax.test"]),
    });
    const info = await pool.getInfo();
    expect(info.chain_id).toBe(CHAIN_ID);
    expect(calls).toBe(2);
    const wrong = pool.health().find((h) => h.url.includes("wrong"))!;
    expect(wrong.chainIdOk).toBe(false);
    expect(wrong.tradingEligible).toBe(false);
  });
});
