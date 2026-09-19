/**
 * Health-scored Antelope provider pool.
 *
 * Replaces "try list of RPCs in order" with continuous health scoring:
 *
 *   score = 100 × availability × successRate × freshness × latencyScore
 *
 *   freshness    = clamp(1 − blockLag/200, 0.05, 1)   (chain truth, not speed)
 *   latencyScore = clamp(1 − (latencyMs−80)/1720, 0, 1)
 *
 * A node 140 blocks behind is REJECTED for trading regardless of how fast it
 * answers — it is history, not the market. Failover, cooldown and automatic
 * restore are all handled here so a dead WAX node can never kill the engine.
 *
 * Two hard rules the rest of the app relies on:
 *  1. READS fail over (best score → next → next…).
 *  2. TRANSACTIONS do not blind-fail-over. pushTransaction() submits the SAME
 *     signed payload to ONE trading-eligible node; a timeout is surfaced as
 *     `BroadcastTimeoutError` for status reconciliation — never retried here.
 */
import { fetchJson, FetchJsonError, type FetchPriority } from "@/lib/fetchJson";
import {
  effectiveEndpoints,
  onEndpointsChanged,
  WAX_CHAIN_ID,
  type EndpointKind,
  type WaxEndpoint,
} from "./endpoints";

export type EndpointStatus = "healthy" | "degraded" | "cooldown" | "disabled";

export type EndpointHealth = {
  url: string;
  kind: EndpointKind;
  priority: number;
  status: EndpointStatus;
  /** EMA of round-trip ms. null before the first observation. */
  latencyMs: number | null;
  headBlock: number | null;
  libBlock: number | null;
  /** networkHead − headBlock. Stale until any head is known. */
  blockLag: number;
  /** EWMA of call success, 0..1. */
  successRate: number;
  timeoutRate: number;
  consecutiveFailures: number;
  totalCalls: number;
  cooldownUntil: number;
  lastSuccess: number;
  lastError: string | null;
  /** Verified against the WAX mainnet chain id. null = not seen yet. */
  chainIdOk: boolean | null;
  /** 0..100 read score. */
  score: number;
  /** Healthy enough to submit transactions to (fresh + trusted). */
  tradingEligible: boolean;
};

export type PoolCallOpts = {
  timeoutMs?: number;
  priority?: FetchPriority;
  /** HTTP method for non-chain APIs (Hyperion v2 endpoints are GET). */
  method?: "GET" | "POST";
  /** Fail over on 5xx/429 in addition to network errors (default true). */
  failOverOnHttp5xx?: boolean;
  signal?: AbortSignal;
};

export type ChainInfoResult = {
  chain_id: string;
  head_block_num: number;
  last_irreversible_block_num: number;
  head_block_time: string;
};

export class BroadcastTimeoutError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = "BroadcastTimeoutError";
  }
}

/* ------------------------------------------------------------------ */
/* health math — pure, unit-tested                                      */
/* ------------------------------------------------------------------ */

export const TRADING_MAX_BLOCK_LAG = 6;
const FRESHNESS_SPAN = 200;
const LATENCY_FLOOR_MS = 80;
const LATENCY_SPAN_MS = 1720;
const FAILURE_COOLDOWN_MS = 20_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
const EWMA_ALPHA = 0.25;
const CONSECUTIVE_FAILURES_TO_COOLDOWN = 3;

export function freshnessOf(blockLag: number): number {
  if (blockLag <= 0) return 1;
  return Math.max(0.05, 1 - blockLag / FRESHNESS_SPAN);
}

export function latencyScoreOf(latencyMs: number | null): number {
  if (latencyMs == null) return 0.5; // unmeasured: neutral
  return Math.max(0, Math.min(1, 1 - (latencyMs - LATENCY_FLOOR_MS) / LATENCY_SPAN_MS));
}

export function scoreOf(h: {
  status: EndpointStatus;
  successRate: number;
  blockLag: number;
  latencyMs: number | null;
}): number {
  if (h.status === "disabled" || h.status === "cooldown") return 0;
  return (
    100 *
    Math.max(0, Math.min(1, h.successRate)) *
    freshnessOf(h.blockLag) *
    latencyScoreOf(h.latencyMs)
  );
}

export function tradingEligibleOf(h: {
  status: EndpointStatus;
  blockLag: number;
  chainIdOk: boolean | null;
  consecutiveFailures: number;
  successRate: number;
  headBlock: number | null;
}): boolean {
  if (h.status !== "healthy" && h.status !== "degraded") return false;
  if (h.chainIdOk === false) return false;
  if (h.headBlock == null) return false;
  if (h.blockLag > TRADING_MAX_BLOCK_LAG) return false;
  if (h.consecutiveFailures > 0) return false;
  return h.successRate >= 0.5;
}

/** Cooldown length grows with the failure streak, capped. */
export function cooldownFor(streak: number, now: number): number {
  const n = Math.max(1, streak - CONSECUTIVE_FAILURES_TO_COOLDOWN + 1);
  return Math.min(MAX_COOLDOWN_MS, FAILURE_COOLDOWN_MS * 2 ** (n - 1)) + now;
}

/* ------------------------------------------------------------------ */
/* the pool                                                             */
/* ------------------------------------------------------------------ */

export type PoolFetcher = (
  url: string,
  init: { method: "GET" | "POST"; body: unknown },
  timeoutMs: number,
  priority: FetchPriority,
  signal?: AbortSignal,
) => Promise<unknown>;

function operationFromPath(url: string): string {
  if (url.includes("/push_transaction")) return "WAX push_transaction";
  if (url.includes("/get_info")) return "WAX chain info";
  if (url.includes("/get_table_rows")) return "WAX table rows";
  if (url.includes("/get_account")) return "WAX account";
  if (url.includes("/get_currency_balance")) return "WAX balance";
  if (url.includes("/history/get_transaction")) return "WAX history tx";
  if (url.includes("/state/get_tokens")) return "Hyperion tokens";
  return "WAX RPC";
}

const defaultFetcher: PoolFetcher = (url, init, timeoutMs, priority, signal) => {
  const endpoint = url.split("?")[0]!;
  return fetchJson(url, {
    ...init,
    timeoutMs,
    priority,
    signal,
    context: {
      operation: operationFromPath(url),
      endpoint,
      params: init.method === "POST" && typeof init.body === "object" ? (init.body as Record<string, unknown>) : undefined,
    },
  });
};

type HealthRecord = {
  ep: WaxEndpoint;
  latencyMs: number | null;
  headBlock: number | null;
  libBlock: number | null;
  successEwma: number | null;
  timeoutEwma: number | null;
  consecutiveFailures: number;
  totalCalls: number;
  cooldownUntil: number;
  lastSuccess: number;
  lastError: string | null;
  chainIdOk: boolean | null;
};

/** Was the failure a node problem (fail over) or a real answer (don't)? */
export function isFailOverError(err: unknown): boolean {
  if (err instanceof FetchJsonError) {
    const s = err.status ?? 0;
    return s >= 500 || s === 429 || s === 503;
  }
  // Network / CORS / timeout / abort — the node never answered.
  return true;
}

function isTimeoutError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  return name === "TimeoutError" || name === "AbortError" || /timeout|aborted/i.test(msg);
}

/**
 * Is this broadcast HTTP error AMBIGUOUS — i.e. the transaction may have
 * landed? nodeos answers real rejections with a JSON
 * `{"code":…,"error":{…}}` body — those are definitive. But:
 *
 *  - a body containing "duplicate transaction" means the tx DID land
 *    (Antelope dedupes by txid), and
 *  - edge-proxy answers (429/503/5xx HTML or text pages) carry no nodeos
 *    error object — the proxy may have forwarded the request upstream
 *    before its own response path died.
 *
 * Those must be reconciled by the known txid, never treated as a definitive
 * failure that unlocks the capital for a re-trade.
 */
export function isAmbiguousBroadcastError(err: FetchJsonError): boolean {
  const body = err.context?.body ?? "";
  if (/duplicate transaction/i.test(body)) return true; // the tx LANDED
  return !/"error"\s*:/.test(body); // no nodeos error object → not definitive
}

export class ProviderPool {
  private records = new Map<string, HealthRecord>();
  private clock: () => number;
  private fetcher: PoolFetcher;
  private kind: EndpointKind;
  private probeIndex = 0;
  /** Test/config override for the endpoint list. */
  private endpointSource: (() => WaxEndpoint[]) | null = null;

  constructor(opts: {
    kind: EndpointKind;
    fetcher?: PoolFetcher;
    clock?: () => number;
    /** Fixed endpoint list (tests); default = user config + curated pool. */
    endpoints?: WaxEndpoint[];
  }) {
    this.kind = opts.kind;
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.clock = opts.clock ?? Date.now;
    this.endpointSource = opts.endpoints ? () => opts.endpoints! : null;
    this.reload();
    onEndpointsChanged(() => this.reload());
  }

  /** Re-read the endpoint list (user config may have changed). */
  reload(): void {
    const { rpc, history } = effectiveEndpoints();
    const list = this.endpointSource
      ? this.endpointSource()
      : this.kind === "rpc"
        ? rpc
        : history;
    const next = new Map<string, HealthRecord>();
    for (const ep of list) {
      const prev = this.records.get(ep.url);
      next.set(ep.url, {
        ep,
        latencyMs: prev?.latencyMs ?? null,
        headBlock: prev?.headBlock ?? null,
        libBlock: prev?.libBlock ?? null,
        successEwma: prev?.successEwma ?? null,
        timeoutEwma: prev?.timeoutEwma ?? null,
        consecutiveFailures: prev?.consecutiveFailures ?? 0,
        totalCalls: prev?.totalCalls ?? 0,
        cooldownUntil: prev?.cooldownUntil ?? 0,
        lastSuccess: prev?.lastSuccess ?? 0,
        lastError: prev?.lastError ?? null,
        chainIdOk: prev?.chainIdOk ?? null,
      });
    }
    this.records = next;
  }

  /* ---------------------------- health view ------------------------- */

  private statusOf(r: HealthRecord): EndpointStatus {
    if (!r.ep.enabled) return "disabled";
    if (r.cooldownUntil > this.clock()) return "cooldown";
    if (r.consecutiveFailures > 0 || (r.successEwma != null && r.successEwma < 0.8)) {
      return "degraded";
    }
    return "healthy";
  }

  private blockLagOf(r: HealthRecord): number {
    const head = this.networkHead();
    if (head == null || r.headBlock == null) return 0;
    return Math.max(0, head - r.headBlock);
  }

  /** Highest head block any endpoint has reported = the network head. */
  networkHead(): number | null {
    let head: number | null = null;
    for (const r of this.records.values()) {
      if (r.headBlock != null && (head == null || r.headBlock > head)) head = r.headBlock;
    }
    return head;
  }

  health(): EndpointHealth[] {
    const out: EndpointHealth[] = [];
    for (const r of this.records.values()) {
      const status = this.statusOf(r);
      const blockLag = this.blockLagOf(r);
      const successRate = r.successEwma ?? 0.5;
      const score = scoreOf({ status, successRate, blockLag, latencyMs: r.latencyMs });
      out.push({
        url: r.ep.url,
        kind: r.ep.kind,
        priority: r.ep.priority,
        status,
        latencyMs: r.latencyMs,
        headBlock: r.headBlock,
        libBlock: r.libBlock,
        blockLag,
        successRate,
        timeoutRate: r.timeoutEwma ?? 0,
        consecutiveFailures: r.consecutiveFailures,
        totalCalls: r.totalCalls,
        cooldownUntil: r.cooldownUntil,
        lastSuccess: r.lastSuccess,
        lastError: r.lastError,
        chainIdOk: r.chainIdOk,
        score: Math.round(score * 10) / 10,
        tradingEligible: tradingEligibleOf({
          status,
          blockLag,
          chainIdOk: r.chainIdOk,
          consecutiveFailures: r.consecutiveFailures,
          successRate,
          headBlock: r.headBlock,
        }),
      });
    }
    out.sort((a, b) => b.score - a.score || a.priority - b.priority);
    return out;
  }

  /** Healthiest endpoint overall (for the status panel + watch heartbeat). */
  best(): EndpointHealth | null {
    return this.health()[0] ?? null;
  }

  private recordFor(url: string): HealthRecord | undefined {
    return this.records.get(url);
  }

  /* ---------------------------- observation ------------------------- */

  private observeStart(url: string): HealthRecord {
    const r = this.records.get(url);
    if (!r) throw new Error(`Unknown endpoint ${url}`);
    r.totalCalls += 1;
    return r;
  }

  private observeOk(url: string, ms: number, res: unknown): void {
    const r = this.recordFor(url);
    if (!r) return;
    r.latencyMs = r.latencyMs == null ? ms : r.latencyMs * (1 - EWMA_ALPHA) + ms * EWMA_ALPHA;
    r.successEwma = r.successEwma == null ? 1 : r.successEwma * (1 - EWMA_ALPHA) + EWMA_ALPHA;
    r.timeoutEwma = (r.timeoutEwma ?? 0) * (1 - EWMA_ALPHA);
    r.consecutiveFailures = 0;
    r.lastSuccess = this.clock();
    r.lastError = null;
    if (r.cooldownUntil > 0 && this.clock() > r.cooldownUntil) r.cooldownUntil = 0;

    // Any get_info-shaped response teaches us head/LIB/chain id.
    const info = res as
      | {
          head_block_num?: number;
          last_irreversible_block_num?: number;
          chain_id?: string;
        }
      | null;
    if (info && typeof info === "object" && typeof info.head_block_num === "number") {
      if (info.head_block_num > 0) r.headBlock = info.head_block_num;
      if (typeof info.last_irreversible_block_num === "number") {
        r.libBlock = info.last_irreversible_block_num;
      }
      if (typeof info.chain_id === "string" && info.chain_id.length === 64) {
        r.chainIdOk = info.chain_id === WAX_CHAIN_ID;
      }
    }
  }

  private observeFail(url: string, err: unknown): void {
    const r = this.recordFor(url);
    if (!r) return;
    const failed = 0;
    r.successEwma = r.successEwma == null ? failed : r.successEwma * (1 - EWMA_ALPHA) + failed * EWMA_ALPHA;
    if (isTimeoutError(err)) {
      r.timeoutEwma = r.timeoutEwma == null ? 1 : r.timeoutEwma * (1 - EWMA_ALPHA) + EWMA_ALPHA;
    }
    r.consecutiveFailures += 1;
    r.lastError = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
    if (r.consecutiveFailures >= CONSECUTIVE_FAILURES_TO_COOLDOWN) {
      r.cooldownUntil = cooldownFor(r.consecutiveFailures, this.clock());
    }
  }

  /* ---------------------------- selection --------------------------- */

  private candidates(): HealthRecord[] {
    const now = this.clock();
    // Once an RPC identifies itself as the wrong chain it is never selected
    // again — not even for reads. Signatures/TAPOS from another Antelope
    // chain must never enter the WAX market session.
    const live = [...this.records.values()].filter(
      (r) => r.ep.enabled && (this.kind !== "rpc" || r.chainIdOk !== false),
    );
    const ready = live.filter((r) => r.cooldownUntil <= now);
    const sorted = ready.sort((a, b) => {
      const sa = scoreOf({
        status: this.statusOf(a),
        successRate: a.successEwma ?? 0.5,
        blockLag: this.blockLagOf(a),
        latencyMs: a.latencyMs,
      });
      const sb = scoreOf({
        status: this.statusOf(b),
        successRate: b.successEwma ?? 0.5,
        blockLag: this.blockLagOf(b),
        latencyMs: b.latencyMs,
      });
      return sb - sa || a.ep.priority - b.ep.priority;
    });
    if (sorted.length > 0) return sorted;
    // Everything is cooling down — try the soonest-to-recover nodes rather
    // than dying. A dead RPC must not kill the engine.
    return live.sort((a, b) => a.cooldownUntil - b.cooldownUntil).slice(0, 2);
  }

  /* ---------------------------- operations -------------------------- */

  /**
   * READ call with automatic failover, best-health first. HTTP 4xx answers
   * (eosio_assert etc.) are real chain answers and do NOT fail over.
   */
  async call(path: string, body: unknown, opts: PoolCallOpts = {}): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? 12_000;
    const priority = opts.priority ?? "medium";
    const fail5xx = opts.failOverOnHttp5xx ?? true;
    const list = this.candidates();
    if (list.length === 0) throw new Error(`No ${this.kind} endpoints configured`);

    let lastErr: unknown = new Error(`${this.kind} call failed`);
    for (const r of list) {
      const t0 = this.clock();
      this.observeStart(r.ep.url);
      try {
        const res = await this.fetcher(
          `${r.ep.url}${path}`,
          { method: opts.method ?? "POST", body },
          timeoutMs,
          priority,
          opts.signal,
        );
        // get_info is also the trust handshake. Never return a response from
        // another Antelope chain to transaction/TAPOS code — mark it and
        // continue to the next RPC immediately.
        const maybeInfo = res as { chain_id?: unknown } | null;
        if (
          this.kind === "rpc" &&
          path.endsWith("/get_info") &&
          typeof maybeInfo?.chain_id === "string" &&
          maybeInfo.chain_id !== WAX_CHAIN_ID
        ) {
          const wrong = new Error(`${r.ep.url} returned the wrong chain id`);
          r.chainIdOk = false;
          this.observeFail(r.ep.url, wrong);
          lastErr = wrong;
          continue;
        }
        this.observeOk(r.ep.url, this.clock() - t0, res);
        return res;
      } catch (err) {
        this.observeFail(r.ep.url, err);
        lastErr = err;
        if (err instanceof FetchJsonError && (!fail5xx || ((err.status ?? 0) < 500 && err.status !== 429 && err.status !== 503))) {
          throw err; // definitive answer — fail over would just repeat it
        }
      }
    }
    throw lastErr;
  }

  /**
   * Submit a SIGNED transaction. Single submission to the healthiest
   * trading-eligible node — no blind retry. A network timeout throws
   * BroadcastTimeoutError (the tx may have landed; the caller reconciles).
   */
  async pushTransaction(
    path: string,
    body: unknown,
    opts: { timeoutMs?: number; priority?: FetchPriority } = {},
  ): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const eligible = this.candidates().filter((r) => {
      const status = this.statusOf(r);
      return tradingEligibleOf({
        status,
        blockLag: this.blockLagOf(r),
        chainIdOk: r.chainIdOk,
        consecutiveFailures: r.consecutiveFailures,
        successRate: r.successEwma ?? 0.5,
        headBlock: r.headBlock,
      });
    });
    const target = eligible[0] ?? this.candidates()[0];
    if (!target) throw new Error("No RPC endpoint available to broadcast");

    const t0 = this.clock();
    this.observeStart(target.ep.url);
    try {
      const res = await this.fetcher(
        `${target.ep.url}${path}`,
        { method: "POST", body },
        timeoutMs,
        opts.priority ?? "high",
      );
      this.observeOk(target.ep.url, this.clock() - t0, res);
      return res;
    } catch (err) {
      this.observeFail(target.ep.url, err);
      // ANY failure without a definitive nodeos rejection is ambiguous: the
      // request may have reached the node (or landed outright, for a
      // "duplicate transaction" body) before the response path died.
      // Surface it as a broadcast timeout so the known txid is reconciled
      // and the capital stays locked — never re-sent, never unlocked.
      if (
        !(err instanceof FetchJsonError) ||
        isTimeoutError(err) ||
        isAmbiguousBroadcastError(err)
      ) {
        throw new BroadcastTimeoutError(
          `Broadcast to ${target.ep.url} had no definitive response — the transaction may still land; not resubmitting`,
          target.ep.url,
        );
      }
      throw err; // definitive nodeos rejection (safe for chain.ts to classify)
    }
  }

  /** Probe one endpoint directly and feed its get_info into health scoring. */
  private async probeRecord(r: HealthRecord): Promise<void> {
    const t0 = this.clock();
    this.observeStart(r.ep.url);
    try {
      const res = await this.fetcher(
        `${r.ep.url}/v1/chain/get_info`,
        { method: "POST", body: {} },
        4_000,
        "low",
      );
      const info = res as { chain_id?: unknown } | null;
      if (
        this.kind === "rpc" &&
        typeof info?.chain_id === "string" &&
        info.chain_id !== WAX_CHAIN_ID
      ) {
        r.chainIdOk = false;
        this.observeFail(r.ep.url, new Error(`${r.ep.url} returned the wrong chain id`));
        return;
      }
      this.observeOk(r.ep.url, this.clock() - t0, res);
    } catch (err) {
      this.observeFail(r.ep.url, err);
    }
  }

  /**
   * Health-probe pass: nudge cooled-down endpoints back. One probe per call
   * (round-robin) so recovery traffic stays negligible. Returns true if a
   * probe was issued.
   */
  async probe(): Promise<boolean> {
    const now = this.clock();
    // One lightweight probe per engine pass — never all endpoints at once.
    // Prioritize recovery candidates, then unmeasured/stale health records so
    // every node eventually has a head/latency score without turning each
    // market tick into ten requests.
    const records = [...this.records.values()].filter(
      (r) => r.ep.enabled && r.chainIdOk !== false,
    );
    const recovering = records.filter((r) => r.consecutiveFailures > 0);
    const stale = records
      .filter((r) => r.consecutiveFailures === 0 && (r.lastSuccess === 0 || now - r.lastSuccess > 60_000))
      .sort((a, b) => a.lastSuccess - b.lastSuccess);
    const candidates = recovering.length > 0 ? recovering : stale;
    if (candidates.length === 0) return false;
    const r = candidates[this.probeIndex++ % candidates.length]!;
    await this.probeRecord(r);
    return true;
  }

  /**
   * Explicit full health pass (diagnostics/tests/user-requested resync only).
   * Normal operation uses probe(), one endpoint per pass, to stay polite.
   */
  async probeAll(): Promise<void> {
    for (const r of this.records.values()) {
      if (r.ep.enabled && r.chainIdOk !== false) await this.probeRecord(r);
    }
  }

  /** Direct get_info (used by the block watcher heartbeat). */
  async getInfo(timeoutMs = 4_000): Promise<ChainInfoResult> {
    return (await this.call("/v1/chain/get_info", {}, {
      timeoutMs,
      priority: "high",
    })) as ChainInfoResult;
  }
}

/* Singletons: one RPC pool + one Hyperion history pool for the whole app. */
export const rpcPool = new ProviderPool({ kind: "rpc" });
export const historyPool = new ProviderPool({ kind: "history" });
