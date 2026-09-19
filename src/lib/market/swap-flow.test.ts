/**
 * E-1 swap-flow layer: parsing, rolling flow state, global_sequence dedupe,
 * free checkpoints (+ routeCache version bumps), poller discipline
 * (backoff / hidden-tab pause / single-flight / catch-up paging) and the
 * veto-only danger wiring.
 */
import { describe, expect, it } from "vitest";
import { dangerScore } from "@/lib/leef/regime";
import type { LeefPool } from "@/lib/leef/types";
import { applyOnchainToLeefPool } from "@/lib/wax/alcor-onchain";
import { RouteCache } from "./route-cache";
import {
  CHECKPOINT_TOLERANCE_PCT,
  FLOW_BACKOFF_BASE_MS,
  FLOW_BACKOFF_MAX_MS,
  FLOW_OVERLAP_MS,
  FLOW_WINDOW_MS,
  FlowTracker,
  SeqDedupe,
  SwapFlowService,
  aggregateFlowRisk,
  checkpointDrift,
  checkpointForLeefPool,
  flowBackoffMs,
  latestCheckpoints,
  logswapPath,
  parseFlowAsset,
  parseLogswapAction,
  type LogswapEvent,
  type PoolFlowState,
} from "./swap-flow";

const T0 = Date.parse("2026-09-19T12:00:00Z");

function leefPool(over: Partial<LeefPool> = {}): LeefPool {
  return {
    id: 217,
    fee: 3000,
    feePct: 0.3,
    leef: { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, quantity: 4_500_000_000 },
    pair: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: 110_000 },
    leefIsA: true,
    tvlUsd: 10_000,
    volume24Usd: 500,
    volumeWeekUsd: 0,
    volumeUsdMonth: 0,
    volumeUsd90: 0,
    volumeLeef24: 0,
    volumePair24: 0,
    change24: 0,
    changeWeek: 0,
    liquidity: "19000000000000", // stale vs the checkpoint below
    pairPerLeef: 0.000024,
    leefPerPair: 41_000,
    waxPerLeef: 0.000024,
    usdPerLeef: null,
    sqrtPriceX64: "29000000000000000000", // stale
    tickSpacing: 60,
    ...over,
  };
}

function hyperionAction(
  seq: number,
  over: {
    at?: number;
    poolId?: number;
    trx?: string;
    tokenA?: string;
    tokenB?: string;
    sqrt?: string;
    liquidity?: string;
    reserveA?: string;
    reserveB?: string;
  } = {},
): unknown {
  return {
    trx_id: over.trx ?? `trx-${Math.floor(seq / 3)}`, // multi-hop: several seqs share a trx
    global_sequence: seq,
    block_num: 3_000_000 + seq,
    "@timestamp": new Date(over.at ?? T0 + seq * 500).toISOString(),
    act: {
      account: "swap.alcor",
      name: "logswap",
      data: {
        poolId: over.poolId ?? 217,
        sender: "trader.wam",
        recipient: "trader.wam",
        tokenA: over.tokenA ?? "-25000.0000 LEEF",
        tokenB: over.tokenB ?? "1.23456789 WAX",
        sqrtPriceX64: over.sqrt ?? "29663563357779418305",
        liquidity: over.liquidity ?? "20077984976034",
        tick: 9501,
        reserveA: over.reserveA ?? "4565638459.0000 LEEF",
        reserveB: over.reserveB ?? "112613.00800000 WAX",
      },
    },
  };
}

function event(seq: number, over: Parameters<typeof hyperionAction>[1] = {}): LogswapEvent {
  const ev = parseLogswapAction(hyperionAction(seq, over));
  if (!ev) throw new Error("fixture did not parse");
  return ev;
}

describe("logswap parsing", () => {
  it("parses signed assets with precision from the string", () => {
    expect(parseFlowAsset("-12.74126792 WAX")).toEqual({
      quantity: -12.74126792,
      symbol: "WAX",
      decimals: 8,
    });
    expect(parseFlowAsset("0.00471439 YNOT")).toEqual({
      quantity: 0.00471439,
      symbol: "YNOT",
      decimals: 8,
    });
    expect(parseFlowAsset("12345 LEEF")).toEqual({ quantity: 12345, symbol: "LEEF", decimals: 0 });
    expect(parseFlowAsset(42.5)).toEqual({ quantity: 42.5, symbol: "", decimals: 0 });
    expect(parseFlowAsset("garbage")).toBeNull();
    expect(parseFlowAsset(undefined)).toBeNull();
  });

  it("parses a full Hyperion action row into a typed event", () => {
    const ev = event(77, { at: T0 + 1_000 });
    expect(ev.poolId).toBe(217);
    expect(ev.globalSeq).toBe(77);
    expect(ev.at).toBe(T0 + 1_000);
    expect(ev.tokenA.quantity).toBe(-25_000);
    expect(ev.tokenA.symbol).toBe("LEEF");
    expect(ev.tokenB.quantity).toBeCloseTo(1.23456789, 8);
    expect(ev.sqrtPriceX64).toBe("29663563357779418305");
    expect(ev.reserveA?.quantity).toBeCloseTo(4_565_638_459, 0);
  });

  it("rejects rows without usable data", () => {
    expect(parseLogswapAction(null)).toBeNull();
    expect(parseLogswapAction({ act: { name: "logswap" } })).toBeNull();
    expect(
      parseLogswapAction({ global_sequence: "x", act: { data: { poolId: 1 } } }),
    ).toBeNull();
  });

  it("builds the documented poll path (time-windowed, desc, skip for paging)", () => {
    const p = logswapPath("2026-09-19T11:59:50.000Z", 0);
    expect(p).toContain("/v2/history/get_actions?");
    expect(p).toContain("act.account=swap.alcor");
    expect(p).toContain("act.name=logswap");
    expect(p).toContain("limit=100");
    expect(p).toContain("sort=desc");
    expect(p).not.toContain("skip=");
    expect(logswapPath("2026-09-19T11:59:50.000Z", 300)).toContain("skip=300");
  });
});

describe("global_sequence dedupe", () => {
  it("drops exact repeats but never collapses a multi-hop transaction", () => {
    const d = new SeqDedupe();
    // One trx, three hops: three DIFFERENT global_sequences — all are real swaps.
    const evs = [event(10, { trx: "shared" }), event(11, { trx: "shared" }), event(12, { trx: "shared" })];
    const fresh = evs.filter((e) => d.note(e.globalSeq));
    expect(fresh).toHaveLength(3);
    // The overlap window re-delivers the same actions: dedupe by sequence.
    expect(evs.filter((e) => d.note(e.globalSeq))).toHaveLength(0);
  });

  it("bounds memory (oldest sequences evicted past the cap)", () => {
    const d = new SeqDedupe(8);
    for (let i = 0; i < 20; i++) d.note(i);
    expect(d.size).toBe(8);
    expect(d.has(0)).toBe(false);
    expect(d.has(19)).toBe(true);
  });
});

describe("flow-state reducer (signed deltas → imbalance)", () => {
  it("a LEEF outflow is a BUY; signed flow and imbalance follow", () => {
    const t = new FlowTracker();
    t.note(event(1, { at: T0 - 5_000 }), "A"); // -25000 LEEF / +1.23456789 WAX
    const s = t.stateFor(217, T0);
    expect(s.swapsInWindow).toBe(1);
    expect(s.buys).toBe(1);
    expect(s.sells).toBe(0);
    expect(s.signedBaseFlow).toBe(25_000); // net LEEF bought
    expect(s.signedQuoteFlow).toBeCloseTo(1.23456789, 8);
    expect(s.imbalancePct).toBe(100);
    expect(s.largestSwapQuote).toBeCloseTo(1.23456789, 8);
    expect(s.lastSwapAgeMs).toBe(5_000);
    // Observed span clamped to ≥1min: 1.23456789 WAX over 1 min.
    expect(s.volumeQuotePerMin).toBeCloseTo(1.23456789, 8);
  });

  it("equal buy and sell volume nets to zero imbalance", () => {
    const t = new FlowTracker();
    t.note(event(1, { at: T0 - 2_000 }), "A"); // buy
    t.note(
      event(2, { at: T0 - 1_000, tokenA: "25000.0000 LEEF", tokenB: "-1.23456789 WAX" }),
      "A",
    ); // sell, same size
    const s = t.stateFor(217, T0);
    expect(s.buys).toBe(1);
    expect(s.sells).toBe(1);
    expect(s.imbalancePct).toBeCloseTo(0, 8);
    expect(s.signedBaseFlow).toBeCloseTo(0, 8);
    expect(s.volumeQuotePerMin).toBeCloseTo(2 * 1.23456789, 6);
  });

  it("prunes swaps older than the rolling window", () => {
    const t = new FlowTracker();
    t.note(event(1, { at: T0 - FLOW_WINDOW_MS - 1_000 }), "A");
    t.note(event(2, { at: T0 - 1_000 }), "A");
    const s = t.stateFor(217, T0);
    expect(s.swapsInWindow).toBe(1);
    expect(s.lastSwapAgeMs).toBe(1_000);
  });

  it("measures the last swap's book move from consecutive checkpoints", () => {
    const t = new FlowTracker();
    t.note(event(1, { at: T0 - 2_000, sqrt: "1000000000000000000" }), "A");
    t.note(event(2, { at: T0 - 1_000, sqrt: "1010000000000000000" }), "A");
    const s = t.stateFor(217, T0);
    // price ∝ sqrt² → 1.01² − 1 = 2.01%
    expect(s.lastMovePct).toBeCloseTo(2.01, 1);
  });

  it("resolves the LEEF side for B-side LEEF pools", () => {
    const t = new FlowTracker();
    // LEEF is tokenB here: negative tokenB delta = LEEF bought.
    t.note(
      event(1, { at: T0 - 1_000, tokenA: "1.23456789 WAX", tokenB: "-25000.0000 LEEF" }),
      "B",
    );
    const s = t.stateFor(217, T0);
    expect(s.buys).toBe(1);
    expect(s.signedBaseFlow).toBe(25_000);
  });
});

describe("free pool-state checkpoints", () => {
  it("builds an on-chain row from the post-swap payload", () => {
    const cp = checkpointForLeefPool(event(5), leefPool());
    expect(cp).not.toBeNull();
    expect(cp!.id).toBe(217);
    expect(cp!.active).toBe(true);
    expect(cp!.sqrtPriceX64).toBe("29663563357779418305");
    expect(cp!.liquidity).toBe("20077984976034");
    expect(cp!.tokenA.symbol).toBe("LEEF");
    expect(cp!.tokenA.quantity).toBeCloseTo(4_565_638_459, 0);
    expect(cp!.tokenB.symbol).toBe("WAX");
    expect(cp!.priceAInB).toBeGreaterThan(0);
  });

  it("refuses checkpoints that fail identity or completeness", () => {
    const pool = leefPool();
    // Payload token symbols disagree with the tracked pool → parse/identity bug.
    expect(
      checkpointForLeefPool(event(1, { tokenA: "-1.0 USDT", tokenB: "2.0 WAX" }), pool),
    ).toBeNull();
    // No reserves → nothing safe to patch.
    expect(checkpointForLeefPool(event(1, { reserveA: "", reserveB: "" }), pool)).toBeNull();
  });

  it("patches the snapshot pool and bumps the routeCache version via notePools", () => {
    const pool = leefPool();
    const cp = checkpointForLeefPool(event(5), pool)!;
    const patched = applyOnchainToLeefPool(pool, cp);
    expect(patched).not.toBeNull();
    expect(patched!.sqrtPriceX64).toBe("29663563357779418305");
    expect(patched!.liquidity).toBe("20077984976034");
    expect(patched!.leef.quantity).toBeCloseTo(4_565_638_459, 0);

    const cache = new RouteCache();
    expect(cache.notePools([pool])).toEqual([217]); // first sighting
    expect(cache.notePools([pool])).toEqual([]); // unchanged
    expect(cache.notePools([patched!])).toEqual([217]); // checkpoint → version bump
    expect(cache.versionOf(217)).toBe(2);
  });

  it("keeps only the latest global_sequence per hot pool", () => {
    const pool = leefPool();
    const snap = { pools: [pool], aux: [] };
    const older = event(1, { sqrt: "1111111111111111111" });
    const newer = event(9, { sqrt: "29663563357779418305" });
    const otherPool = event(10, { poolId: 999 });
    const cps = latestCheckpoints([newer, older, otherPool], snap, [217]);
    expect(cps).toHaveLength(1); // pool 999 is not hot
    expect(cps[0]!.sqrtPriceX64).toBe("29663563357779418305");
  });

  it("validates checkpoints against table reads with a tolerance band", () => {
    const cp = checkpointForLeefPool(event(5), leefPool())!;
    // Identical truth → consistent.
    expect(checkpointDrift(cp, { ...cp })).toBeNull();
    // A >tolerance disagreement implies a parse/identity bug → mismatch.
    const bad = { ...cp, liquidity: "1" };
    const mm = checkpointDrift(cp, bad);
    expect(mm).not.toBeNull();
    expect(mm!.liquidityDriftPct).toBeGreaterThan(CHECKPOINT_TOLERANCE_PCT);
  });
});

describe("poller discipline", () => {
  it("backs off exponentially to 60s", () => {
    expect(flowBackoffMs(0)).toBe(0);
    expect(flowBackoffMs(1)).toBe(FLOW_BACKOFF_BASE_MS);
    expect(flowBackoffMs(2)).toBe(20_000);
    expect(flowBackoffMs(3)).toBe(40_000);
    expect(flowBackoffMs(4)).toBe(FLOW_BACKOFF_MAX_MS);
    expect(flowBackoffMs(12)).toBe(FLOW_BACKOFF_MAX_MS);
  });

  function harness(actions: unknown[] | Error, opts: { hidden?: boolean } = {}) {
    let now = T0;
    const paths: string[] = [];
    const svc = new SwapFlowService({
      now: () => now,
      isHidden: () => opts.hidden ?? false,
      call: async (path: string) => {
        paths.push(path);
        if (actions instanceof Error) throw actions;
        return { actions };
      },
    });
    return {
      svc,
      paths,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("pauses while the tab is hidden", async () => {
    const h = harness([hyperionAction(1)], { hidden: true });
    expect(await h.svc.poll()).toBeNull();
    expect(h.paths).toHaveLength(0);
  });

  it("dedupes the overlap window across polls and advances lastSeen", async () => {
    const h = harness([hyperionAction(1, { at: T0 - 500 }), hyperionAction(2, { at: T0 - 250 })]);
    const first = await h.svc.poll();
    expect(first?.map((e) => e.globalSeq)).toEqual([1, 2]);
    expect(h.paths[0]).toContain("after=");
    const again = await h.svc.poll();
    expect(again).toEqual([]); // same actions, all duplicates
    // The second poll's `after` moved to lastSeen − overlap.
    const afterParam = new URLSearchParams(h.paths[1]!.split("?")[1]!).get("after")!;
    expect(Date.parse(afterParam)).toBe(T0 - 250 - FLOW_OVERLAP_MS);
  });

  it("backs off after a failure and skips polls until the backoff elapses", async () => {
    let failing = true;
    let now = T0;
    const paths: string[] = [];
    const svc = new SwapFlowService({
      now: () => now,
      isHidden: () => false,
      call: async (path: string) => {
        paths.push(path);
        if (failing) throw new Error("node down");
        return { actions: [hyperionAction(1)] };
      },
    });
    expect(await svc.poll()).toBeNull(); // failure → swallowed, backoff armed
    expect(svc.stats().failures).toBe(1);
    expect(paths).toHaveLength(1);
    now += FLOW_BACKOFF_BASE_MS - 1;
    expect(await svc.poll()).toBeNull(); // still backing off — no new request
    expect(paths).toHaveLength(1);
    now += 2;
    failing = false;
    const recovered = await svc.poll();
    expect(recovered).toHaveLength(1); // backoff elapsed → polls again
    expect(paths).toHaveLength(2);
    expect(svc.stats().failures).toBe(0);
  });

  it("is single-flight: a concurrent poll is a no-op", async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => {
      release = r;
    });
    let calls = 0;
    const svc = new SwapFlowService({
      now: () => T0,
      isHidden: () => false,
      call: () => {
        calls += 1;
        return gate.then(() => ({ actions: [hyperionAction(1)] }));
      },
    });
    const p1 = svc.poll();
    const p2 = await svc.poll(); // must not start a second request
    expect(p2).toBeNull();
    expect(calls).toBe(1);
    release(null);
    expect(await p1).toHaveLength(1);
  });

  it("fetches catch-up pages in parallel when the window overflows one page", async () => {
    const full = Array.from({ length: 100 }, (_, i) => hyperionAction(i + 1, { at: T0 - i * 100 }));
    const skips: number[] = [];
    const svc = new SwapFlowService({
      now: () => T0,
      isHidden: () => false,
      call: async (path: string) => {
        const skip = Number(new URLSearchParams(path.split("?")[1]!).get("skip") ?? 0);
        skips.push(skip);
        return { actions: skip === 0 ? full : [] };
      },
    });
    const events = await svc.poll();
    expect(events).toHaveLength(100);
    expect(skips).toEqual([0, 100, 200, 300, 400]); // page 1 + 4 parallel pages
  });

  it("rate-limits mismatch journaling per pool", () => {
    const svc = new SwapFlowService({ now: () => T0 });
    expect(svc.shouldJournalMismatch(217, T0)).toBe(true);
    expect(svc.shouldJournalMismatch(217, T0 + 60_000)).toBe(false);
    expect(svc.shouldJournalMismatch(218, T0 + 60_000)).toBe(true); // per-pool
    expect(svc.shouldJournalMismatch(217, T0 + 5 * 60_000 + 1)).toBe(true);
  });
});

describe("flow → dangerScore (veto-only risk context)", () => {
  const baseOpts = { quoteAgeMs: 0, maxQuoteAgeMs: 45_000, volPct: 0, dislocationPct: 0 };

  function state(over: Partial<PoolFlowState>): PoolFlowState {
    return {
      poolId: 217,
      swapsInWindow: 3,
      buys: 2,
      sells: 1,
      signedBaseFlow: 0,
      signedQuoteFlow: 0,
      imbalancePct: 0,
      volumeQuotePerMin: 0,
      largestSwapQuote: 0,
      lastSwapAt: 0,
      lastSwapAgeMs: Number.POSITIVE_INFINITY,
      lastMovePct: 0,
      ...over,
    };
  }

  it("aggregates only swaps inside the quote window; neutral otherwise", () => {
    expect(aggregateFlowRisk([], 45_000)).toBeNull();
    const stale = state({ lastSwapAt: T0 - 60_000, lastSwapAgeMs: 60_000, lastMovePct: 5 });
    expect(aggregateFlowRisk([stale], 45_000)).toBeNull();
    const hot = state({ lastSwapAt: T0 - 2_000, lastSwapAgeMs: 2_000, lastMovePct: 2.5, imbalancePct: -90 });
    expect(aggregateFlowRisk([stale, hot], 45_000)).toEqual({
      lastSwapAgeMs: 2_000,
      lastMovePct: 2.5,
      imbalancePct: -90,
    });
  });

  it("flow only ever RAISES danger — absent or calm flow is neutral", () => {
    const base = dangerScore(baseOpts);
    expect(base.score).toBe(0);
    const calm = dangerScore({
      ...baseOpts,
      flow: { lastSwapAgeMs: 2_000, lastMovePct: 0.4, imbalancePct: 30 },
    });
    expect(calm.score).toBe(base.score);
  });

  it("a book that just moved and one-sided flow add danger points", () => {
    const d = dangerScore({
      ...baseOpts,
      flow: { lastSwapAgeMs: 2_000, lastMovePct: 3, imbalancePct: -90 },
    });
    expect(d.score).toBe(30); // 20 (move) + 10 (one-sided)
    expect(d.explain.join(" ")).toContain("book moved");
    expect(d.explain.join(" ")).toContain("one-sided flow");
    // Same calm inputs without flow → normal band; the flow version is worse.
    expect(d.score).toBeGreaterThan(dangerScore(baseOpts).score);
  });
});
