/**
 * Swap-flow intelligence layer (ALCOR_COMPARATIVE_AUDIT §4 / E-1).
 *
 * One Hyperion call per ~10 s against the existing health-scored
 * `historyPool` — the waxterminal logswap discipline, serverless:
 *
 *   GET /v2/history/get_actions?act.account=swap.alcor&act.name=logswap
 *       &after=<lastSeen−overlap>&limit=100&sort=desc
 *
 *   · time-windowed paging (parallel pages when catching up — a fixed action
 *     count is a useless window on a busy tape)
 *   · dedupe by `global_sequence`, NEVER trx_id (a multi-hop route is several
 *     real swaps inside one transaction)
 *   · paused while the tab is hidden, exponential backoff to 60 s on failure,
 *     single-flight
 *
 * Every logswap is a free, contract-signed pool-state checkpoint: post-swap
 * sqrtPriceX64 / liquidity / reserves without a table read. For tracked hot
 * pools the engine patches these into the snapshot between the 4.5 s table
 * reads (bumping routeCache versions through the normal notePools path) and
 * VALIDATES each checkpoint against the next real table read — mismatches
 * are journaled before the stream is ever trusted.
 *
 * This module is MARKET DATA, not signal: flow state may raise the danger
 * score or tighten freshness, it must never create an entry.
 */
import { q64Price } from "@/lib/leef/amm";
import type { FlowRiskContext } from "@/lib/leef/regime";
import type { AuxPool, LeefPool, LeefSnapshot } from "@/lib/leef/types";
import type { OnchainPool } from "@/lib/wax/alcor-onchain";
import { ALCOR_SWAP } from "@/lib/wax/alcor-onchain";
import { historyPool } from "@/lib/wax/provider-pool";

/* ------------------------------------------------------------------ */
/* parsing                                                              */
/* ------------------------------------------------------------------ */

export type FlowAsset = {
  /** Signed for tokenA/tokenB deltas (negative = left the pool). */
  quantity: number;
  symbol: string;
  decimals: number;
};

/** "-12.74126792 WAX" / "0.00471439 YNOT" / plain number → asset. */
export function parseFlowAsset(raw: unknown): FlowAsset | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? { quantity: raw, symbol: "", decimals: 0 } : null;
  }
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(-?\d+)(?:\.(\d+))?\s+([A-Za-z]{1,7})(?:@[a-z1-5.]+)?$/);
  if (!m) return null;
  const frac = m[2] ?? "";
  return {
    quantity: Number(`${m[1]!}.${frac || "0"}`),
    symbol: m[3]!.toUpperCase(),
    decimals: frac.length,
  };
}

export type LogswapEvent = {
  poolId: number;
  /** Hyperion global action sequence — the ONLY safe dedupe key. */
  globalSeq: number;
  blockNum: number;
  /** ms epoch of the block timestamp. */
  at: number;
  trxId: string;
  sender: string;
  recipient: string;
  /** Signed pool-side deltas (negative = left the pool). */
  tokenA: FlowAsset;
  tokenB: FlowAsset;
  /** Post-swap pool state — the free checkpoint. */
  sqrtPriceX64: string;
  liquidity: string;
  tick: number;
  reserveA: FlowAsset | null;
  reserveB: FlowAsset | null;
};

type HyperionAction = {
  trx_id?: unknown;
  global_sequence?: unknown;
  block_num?: unknown;
  "@timestamp"?: unknown;
  timestamp?: unknown;
  act?: { account?: unknown; name?: unknown; data?: unknown };
};

/** One Hyperion action row → a typed logswap event (null = not usable). */
export function parseLogswapAction(raw: unknown): LogswapEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as HyperionAction;
  const data = a.act?.data;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const poolId = Number(d.poolId ?? d.pool_id);
  const globalSeq = Number(a.global_sequence);
  if (!Number.isFinite(poolId) || !Number.isFinite(globalSeq)) return null;
  const tokenA = parseFlowAsset(d.tokenA ?? d.token_a);
  const tokenB = parseFlowAsset(d.tokenB ?? d.token_b);
  if (!tokenA || !tokenB) return null;
  const tsRaw = a["@timestamp"] ?? a.timestamp;
  const at = typeof tsRaw === "string" ? Date.parse(tsRaw) : Number(tsRaw);
  if (!Number.isFinite(at)) return null;
  return {
    poolId,
    globalSeq,
    blockNum: Number(a.block_num) || 0,
    at,
    trxId: typeof a.trx_id === "string" ? a.trx_id : "",
    sender: String(d.sender ?? ""),
    recipient: String(d.recipient ?? ""),
    tokenA,
    tokenB,
    sqrtPriceX64: String(d.sqrtPriceX64 ?? d.sqrt_price_x64 ?? "0"),
    liquidity: String(d.liquidity ?? "0"),
    tick: Number(d.tick) || 0,
    reserveA: parseFlowAsset(d.reserveA ?? d.reserve_a),
    reserveB: parseFlowAsset(d.reserveB ?? d.reserve_b),
  };
}

/* ------------------------------------------------------------------ */
/* global_sequence dedupe (multi-hop routes share a trx — never trx_id) */
/* ------------------------------------------------------------------ */

export class SeqDedupe {
  private seen = new Set<number>();

  constructor(private cap = 4_096) {}

  /** True when the sequence is new; false for an already-seen duplicate. */
  note(seq: number): boolean {
    if (this.seen.has(seq)) return false;
    this.seen.add(seq);
    while (this.seen.size > this.cap) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }

  has(seq: number): boolean {
    return this.seen.has(seq);
  }

  get size(): number {
    return this.seen.size;
  }
}

/* ------------------------------------------------------------------ */
/* per-pool rolling flow state (market data, not signal)                */
/* ------------------------------------------------------------------ */

/** Rolling observation window for flow metrics. */
export const FLOW_WINDOW_MS = 5 * 60_000;
const MAX_TRACKED_PER_POOL = 512;

type TrackedSwap = {
  at: number;
  /** Signed base-side delta from the POOL's perspective (<0 = base bought). */
  baseDelta: number;
  /** Signed quote-side delta from the pool's perspective. */
  quoteDelta: number;
  quoteAbs: number;
};

export type PoolFlowState = {
  poolId: number;
  swapsInWindow: number;
  buys: number;
  sells: number;
  /** Net base bought over the window (positive = buy pressure). */
  signedBaseFlow: number;
  /** Net quote spent over the window (positive = quote entered the pool). */
  signedQuoteFlow: number;
  /** (buyVol − sellVol) / (buyVol + sellVol) × 100, quote units. 0 = balanced. */
  imbalancePct: number;
  /** Quote volume per minute over the observed span. */
  volumeQuotePerMin: number;
  largestSwapQuote: number;
  lastSwapAt: number;
  lastSwapAgeMs: number;
  /** |price move| of the last swap vs the previous checkpoint, percent. */
  lastMovePct: number;
};

export class FlowTracker {
  private swaps = new Map<number, TrackedSwap[]>();
  private lastSqrt = new Map<number, string>();
  private lastMove = new Map<number, number>();

  /**
   * Record one swap. `baseSide` is the pool side whose buy/sell imbalance we
   * track (the LEEF side for LEEF pools, tokenA for aux books). Dedupe is the
   * caller's job (SeqDedupe) — this reducer is intentionally pure.
   */
  note(ev: LogswapEvent, baseSide: "A" | "B"): void {
    const base = baseSide === "A" ? ev.tokenA : ev.tokenB;
    const quote = baseSide === "A" ? ev.tokenB : ev.tokenA;
    const list = this.swaps.get(ev.poolId) ?? [];
    list.push({
      at: ev.at,
      baseDelta: base.quantity,
      quoteDelta: quote.quantity,
      quoteAbs: Math.abs(quote.quantity),
    });
    if (list.length > MAX_TRACKED_PER_POOL) list.splice(0, list.length - MAX_TRACKED_PER_POOL);
    this.swaps.set(ev.poolId, list);

    // Book move of THIS swap: previous post-swap sqrt price ≈ this swap's
    // pre-swap price (barring liquidity events in between).
    const prev = this.lastSqrt.get(ev.poolId);
    if (prev && prev !== "0" && ev.sqrtPriceX64 !== "0" && prev !== ev.sqrtPriceX64) {
      try {
        const a = BigInt(ev.sqrtPriceX64);
        const b = BigInt(prev);
        if (a > 0n && b > 0n) {
          const ratio = Number((a * 1_000_000n) / b) / 1e6;
          const movePct = Math.abs(ratio * ratio - 1) * 100;
          if (Number.isFinite(movePct)) this.lastMove.set(ev.poolId, movePct);
        }
      } catch {
        /* a malformed price string must never break flow tracking */
      }
    }
    if (ev.sqrtPriceX64 !== "0") this.lastSqrt.set(ev.poolId, ev.sqrtPriceX64);
  }

  /** Rolling state for one pool at `now` (prunes the window as a side effect). */
  stateFor(poolId: number, now: number): PoolFlowState {
    const cutoff = now - FLOW_WINDOW_MS;
    const all = this.swaps.get(poolId) ?? [];
    const list = all.filter((s) => s.at >= cutoff);
    if (list.length !== all.length) this.swaps.set(poolId, list);

    let buys = 0;
    let sells = 0;
    let buyVol = 0;
    let sellVol = 0;
    let signedBase = 0;
    let signedQuote = 0;
    let total = 0;
    let largest = 0;
    let lastAt = 0;
    let oldest = 0;
    for (const s of list) {
      signedBase -= s.baseDelta; // pool outflow = market buy
      signedQuote += s.quoteDelta;
      total += s.quoteAbs;
      if (s.quoteAbs > largest) largest = s.quoteAbs;
      if (s.baseDelta < 0) {
        buys += 1;
        buyVol += s.quoteAbs;
      } else if (s.baseDelta > 0) {
        sells += 1;
        sellVol += s.quoteAbs;
      }
      if (s.at > lastAt) lastAt = s.at;
      if (oldest === 0 || s.at < oldest) oldest = s.at;
    }
    const volSum = buyVol + sellVol;
    const spanMs =
      list.length === 0 ? 0 : Math.max(60_000, Math.min(FLOW_WINDOW_MS, now - oldest));
    return {
      poolId,
      swapsInWindow: list.length,
      buys,
      sells,
      signedBaseFlow: signedBase,
      signedQuoteFlow: signedQuote,
      imbalancePct: volSum > 0 ? ((buyVol - sellVol) / volSum) * 100 : 0,
      volumeQuotePerMin: spanMs > 0 ? total / (spanMs / 60_000) : 0,
      largestSwapQuote: largest,
      lastSwapAt: lastAt,
      lastSwapAgeMs: lastAt > 0 ? Math.max(0, now - lastAt) : Number.POSITIVE_INFINITY,
      lastMovePct: this.lastMove.get(poolId) ?? 0,
    };
  }

  /** Rolling state for every pool with any tracked swap. */
  allStates(now: number): PoolFlowState[] {
    const out: PoolFlowState[] = [];
    for (const id of this.swaps.keys()) {
      const s = this.stateFor(id, now);
      if (s.swapsInWindow > 0 || s.lastSwapAt > 0) out.push(s);
    }
    return out.sort((a, b) => b.volumeQuotePerMin - a.volumeQuotePerMin);
  }
}

/* ------------------------------------------------------------------ */
/* free pool-state checkpoints (post-swap state, no table read)         */
/* ------------------------------------------------------------------ */

function sideTokenMatches(ev: FlowAsset, tok: { symbol: string }): boolean {
  // A symbol in the payload must agree with the tracked pool's canonical
  // token identity — a mismatch means a parse/identity bug, not a checkpoint.
  return ev.symbol === "" || ev.symbol === tok.symbol.toUpperCase();
}

function buildCheckpoint(
  ev: LogswapEvent,
  pool: { id: number; fee: number },
  aTok: { symbol: string; contract: string; decimals: number },
  bTok: { symbol: string; contract: string; decimals: number },
): OnchainPool | null {
  if (!ev.reserveA || !ev.reserveB) return null; // no reserves → nothing safe to patch
  if (ev.sqrtPriceX64 === "0" || ev.liquidity === "0") return null;
  if (!sideTokenMatches(ev.tokenA, aTok) || !sideTokenMatches(ev.tokenB, bTok)) return null;
  if (!sideTokenMatches(ev.reserveA, aTok) || !sideTokenMatches(ev.reserveB, bTok)) return null;
  const decA = ev.reserveA.decimals > 0 ? ev.reserveA.decimals : aTok.decimals;
  const decB = ev.reserveB.decimals > 0 ? ev.reserveB.decimals : bTok.decimals;
  const priceAInB = q64Price(ev.sqrtPriceX64, decA, decB);
  if (!(priceAInB != null && priceAInB > 0)) return null;
  return {
    id: pool.id,
    active: true,
    fee: pool.fee,
    tickSpacing: 60,
    liquidity: ev.liquidity,
    sqrtPriceX64: ev.sqrtPriceX64,
    tick: ev.tick,
    tokenA: { symbol: aTok.symbol, contract: aTok.contract, decimals: decA, quantity: ev.reserveA.quantity },
    tokenB: { symbol: bTok.symbol, contract: bTok.contract, decimals: decB, quantity: ev.reserveB.quantity },
    priceAInB,
  };
}

/** Checkpoint for a tracked LEEF pool (A/B sides resolved via `leefIsA`). */
export function checkpointForLeefPool(ev: LogswapEvent, pool: LeefPool): OnchainPool | null {
  const aTok = pool.leefIsA ? pool.leef : pool.pair;
  const bTok = pool.leefIsA ? pool.pair : pool.leef;
  return buildCheckpoint(ev, pool, aTok, bTok);
}

/** Checkpoint for a tracked aux pool (tokenA/tokenB as listed). */
export function checkpointForAuxPool(ev: LogswapEvent, pool: AuxPool): OnchainPool | null {
  return buildCheckpoint(ev, pool, pool.tokenA, pool.tokenB);
}

/**
 * Latest checkpoint per tracked hot pool from a batch of logswap events.
 * Events are ordered by global_sequence so the newest swap wins per pool.
 */
export function latestCheckpoints(
  events: LogswapEvent[],
  snap: Pick<LeefSnapshot, "pools" | "aux">,
  hotIds: number[],
): OnchainPool[] {
  const hot = new Set(hotIds);
  const sorted = [...events].sort((a, b) => a.globalSeq - b.globalSeq);
  const byPool = new Map<number, LogswapEvent>();
  for (const ev of sorted) {
    if (hot.has(ev.poolId)) byPool.set(ev.poolId, ev);
  }
  const out: OnchainPool[] = [];
  for (const [id, ev] of byPool) {
    const leef = snap.pools.find((p) => p.id === id);
    if (leef) {
      const cp = checkpointForLeefPool(ev, leef);
      if (cp) out.push(cp);
      continue;
    }
    const aux = snap.aux.find((p) => p.id === id);
    if (aux) {
      const cp = checkpointForAuxPool(ev, aux);
      if (cp) out.push(cp);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* checkpoint validation against real table reads                        */
/* ------------------------------------------------------------------ */

/** Drift beyond this between a checkpoint and the next table read implies a
 * parse/identity bug, not market movement — journal it. */
export const CHECKPOINT_TOLERANCE_PCT = 1;

export type CheckpointMismatch = {
  poolId: number;
  sqrtDriftPct: number;
  liquidityDriftPct: number;
  reserveDriftPct: number;
};

function pctDiff(a: number, b: number): number {
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base > 0 ? (Math.abs(a - b) / base) * 100 : 0;
}

function bigintPctDiff(a: string, b: string): number {
  try {
    const x = BigInt(a);
    const y = BigInt(b);
    if (x <= 0n || y <= 0n) return x === y ? 0 : 100;
    const hi = x > y ? x : y;
    const lo = x > y ? y : x;
    return Number(((hi - lo) * 10_000n) / hi) / 100;
  } catch {
    return 100;
  }
}

/** Compare a logswap checkpoint with a real table row. Null = consistent. */
export function checkpointDrift(cp: OnchainPool, row: OnchainPool): CheckpointMismatch | null {
  const sqrtDriftPct = bigintPctDiff(cp.sqrtPriceX64, row.sqrtPriceX64);
  const liquidityDriftPct = bigintPctDiff(cp.liquidity, row.liquidity);
  const reserveDriftPct = Math.max(
    pctDiff(cp.tokenA.quantity, row.tokenA.quantity),
    pctDiff(cp.tokenB.quantity, row.tokenB.quantity),
  );
  if (
    sqrtDriftPct <= CHECKPOINT_TOLERANCE_PCT &&
    liquidityDriftPct <= CHECKPOINT_TOLERANCE_PCT &&
    reserveDriftPct <= CHECKPOINT_TOLERANCE_PCT
  ) {
    return null;
  }
  return { poolId: cp.id, sqrtDriftPct, liquidityDriftPct, reserveDriftPct };
}

/* ------------------------------------------------------------------ */
/* the poller                                                            */
/* ------------------------------------------------------------------ */

export const FLOW_PAGE_LIMIT = 100;
/** Parallel catch-up pages beyond the first when a window overflows one page. */
export const FLOW_MAX_PAGES = 5;
/** Re-query overlap so boundary actions are never missed (dedupe absorbs repeats). */
export const FLOW_OVERLAP_MS = 4_000;
/** First poll looks back this far (enough to seed the flow window). */
export const FLOW_INITIAL_WINDOW_MS = 60_000;
export const FLOW_BACKOFF_BASE_MS = 10_000;
export const FLOW_BACKOFF_MAX_MS = 60_000;

/** Exponential backoff: 10 s → 20 s → 40 s → 60 s (cap). */
export function flowBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(FLOW_BACKOFF_MAX_MS, FLOW_BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1));
}

export function logswapPath(afterIso: string, skip: number): string {
  const q = new URLSearchParams({
    "act.account": ALCOR_SWAP,
    "act.name": "logswap",
    after: afterIso,
    limit: String(FLOW_PAGE_LIMIT),
    sort: "desc",
  });
  if (skip > 0) q.set("skip", String(skip));
  return `/v2/history/get_actions?${q.toString()}`;
}

export type SwapFlowDeps = {
  /** History call injector (tests). Default: the shared historyPool, GET. */
  call?: (path: string) => Promise<unknown>;
  isHidden?: () => boolean;
  now?: () => number;
};

export type SwapFlowStats = {
  inflight: boolean;
  failures: number;
  backoffUntil: number;
  lastSeenMs: number;
  lastError: string | null;
  seenSeq: number;
  checkpoints: number;
};

export class SwapFlowService {
  readonly tracker = new FlowTracker();
  private dedupe = new SeqDedupe();
  /** Latest known pool state + provenance. Only "logswap" entries are
   * validated against the next table read (a table row IS the truth). */
  private checkpoints = new Map<number, { row: OnchainPool; source: "logswap" | "table" }>();
  private lastMismatchAt = new Map<number, number>();
  private inflight = false;
  private failures = 0;
  private backoffUntil = 0;
  private lastSeenMs = 0;
  private lastError: string | null = null;

  constructor(private deps: SwapFlowDeps = {}) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private hidden(): boolean {
    if (this.deps.isHidden) return this.deps.isHidden();
    return typeof document !== "undefined" && document.hidden;
  }

  private async call(path: string): Promise<unknown> {
    if (this.deps.call) return this.deps.call(path);
    return historyPool.call(path, {}, { method: "GET", timeoutMs: 8_000, priority: "low" });
  }

  stats(): SwapFlowStats {
    return {
      inflight: this.inflight,
      failures: this.failures,
      backoffUntil: this.backoffUntil,
      lastSeenMs: this.lastSeenMs,
      lastError: this.lastError,
      seenSeq: this.dedupe.size,
      checkpoints: this.checkpoints.size,
    };
  }

  /**
   * One poll pass. Returns the fresh (deduped, seq-ascending) events, or null
   * when the pass was skipped (hidden tab, backoff, single-flight, failure —
   * failures are recorded in stats(), never thrown into the engine).
   */
  async poll(): Promise<LogswapEvent[] | null> {
    const now = this.now();
    if (this.inflight || this.hidden() || now < this.backoffUntil) return null;
    this.inflight = true;
    try {
      const events = await this.fetchWindow(now);
      this.failures = 0;
      this.lastError = null;
      return events;
    } catch (err) {
      this.failures += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.backoffUntil = this.now() + flowBackoffMs(this.failures);
      return null;
    } finally {
      this.inflight = false;
    }
  }

  private async fetchPage(afterIso: string, skip: number): Promise<unknown[]> {
    const raw = (await this.call(logswapPath(afterIso, skip))) as {
      actions?: unknown[];
    } | null;
    return Array.isArray(raw?.actions) ? raw!.actions! : [];
  }

  private async fetchWindow(now: number): Promise<LogswapEvent[]> {
    const afterMs =
      this.lastSeenMs > 0 ? this.lastSeenMs - FLOW_OVERLAP_MS : now - FLOW_INITIAL_WINDOW_MS;
    const afterIso = new Date(afterMs).toISOString();
    const first = await this.fetchPage(afterIso, 0);
    let rows = first;
    if (first.length >= FLOW_PAGE_LIMIT) {
      // The window overflows one page — catch up with parallel pages.
      const rest = await Promise.all(
        Array.from({ length: FLOW_MAX_PAGES - 1 }, (_, i) =>
          this.fetchPage(afterIso, (i + 1) * FLOW_PAGE_LIMIT).catch(() => [] as unknown[]),
        ),
      );
      rows = first.concat(...rest);
    }
    const fresh: LogswapEvent[] = [];
    const parsed: LogswapEvent[] = [];
    for (const r of rows) {
      const ev = parseLogswapAction(r);
      if (ev) parsed.push(ev);
    }
    parsed.sort((a, b) => a.globalSeq - b.globalSeq);
    for (const ev of parsed) {
      if (!this.dedupe.note(ev.globalSeq)) continue; // multi-hop txs stay; exact dupes drop
      fresh.push(ev);
    }
    const maxAt = fresh.reduce((m, e) => Math.max(m, e.at), 0);
    if (maxAt > this.lastSeenMs) this.lastSeenMs = maxAt;
    return fresh;
  }

  /** Feed fresh events into the rolling state, resolving LEEF/A-B sides. */
  track(events: LogswapEvent[], snap: Pick<LeefSnapshot, "pools" | "aux">): void {
    for (const ev of events) {
      const leef = snap.pools.find((p) => p.id === ev.poolId);
      if (leef) {
        this.tracker.note(ev, leef.leefIsA ? "A" : "B");
        continue;
      }
      const aux = snap.aux.find((p) => p.id === ev.poolId);
      if (aux) this.tracker.note(ev, "A");
    }
  }

  /* ------------------------- checkpoint store ----------------------- */

  noteCheckpoints(cps: OnchainPool[]): void {
    for (const cp of cps) this.checkpoints.set(cp.id, { row: cp, source: "logswap" });
  }

  /** A verified table read supersedes the logswap checkpoint. */
  noteTableRow(row: OnchainPool): void {
    this.checkpoints.set(row.id, { row, source: "table" });
  }

  checkpointFor(poolId: number): { row: OnchainPool; source: "logswap" | "table" } | null {
    return this.checkpoints.get(poolId) ?? null;
  }

  /** Rate-limit mismatch journaling to one entry per pool per 5 minutes. */
  shouldJournalMismatch(poolId: number, now: number): boolean {
    const last = this.lastMismatchAt.get(poolId) ?? 0;
    if (now - last < 5 * 60_000) return false;
    this.lastMismatchAt.set(poolId, now);
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* flow → dangerScore risk context (veto-only; never an entry)          */
/* ------------------------------------------------------------------ */

/**
 * Collapse per-pool flow states into the thin risk context dangerScore
 * understands. Only swaps inside the quote window count. Returns null when
 * nothing relevant was observed — the neutral default, zero danger points.
 */
export function aggregateFlowRisk(
  states: PoolFlowState[],
  quoteWindowMs: number,
): FlowRiskContext | null {
  let lastSwapAgeMs: number | null = null;
  let lastMovePct = 0;
  let imbalancePct = 0;
  for (const s of states) {
    if (s.lastSwapAt <= 0 || s.lastSwapAgeMs > quoteWindowMs) continue;
    if (lastSwapAgeMs == null || s.lastSwapAgeMs < lastSwapAgeMs) {
      lastSwapAgeMs = s.lastSwapAgeMs;
    }
    if (s.lastMovePct > lastMovePct) lastMovePct = s.lastMovePct;
    if (Math.abs(s.imbalancePct) > Math.abs(imbalancePct)) imbalancePct = s.imbalancePct;
  }
  if (lastSwapAgeMs == null) return null;
  return { lastSwapAgeMs, lastMovePct, imbalancePct };
}

/** App-wide singleton (the engine owns the cadence). */
export const swapFlow = new SwapFlowService();
