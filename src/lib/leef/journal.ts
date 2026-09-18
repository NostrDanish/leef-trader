/**
 * Evidence journal — the trader's persistent memory.
 *
 * One append-only log in IndexedDB. Every entry is a compact flat record
 * (a few hundred bytes — NEVER a market snapshot; the universe is ~11 MB
 * and would kill storage within days). Kinds:
 *
 *   decision    — every bot decision incl. HOLDs, with the reason
 *   gate        — exact-quote gate verdicts (pass AND fail) with the fresh
 *                 venue quote, so we can measure CP-model vs venue-CLMM
 *                 disagreement before ever building tick-level discovery
 *   execution   — one per submitted/paper trade with chain-observed status
 *   calibration — per closed trade: predicted edge vs realized edge
 *
 * Design rules:
 *   - Fire-and-forget. The journal must NEVER throw into trading code.
 *   - Buffered writes (flush every few seconds / on tab hide), one IDB
 *     transaction per batch — not one per event.
 *   - Bounded storage: prunes oldest entries past MAX_ENTRIES.
 *   - Exports as NDJSON, one JSON object per line, in entry order.
 */
import type { BotStrategy } from "./bot-engine";

export type JournalKind =
  | "decision"
  | "gate"
  | "execution"
  | "calibration"
  | "ai"
  | "counterfactual"
  | "learning";

/**
 * Counterfactual HOLD labels (Phase 2). A HOLD with a concrete candidate is
 * re-evaluated minutes later against real market data:
 *   FALSE_HOLD — the opportunity was real; holding was wrong (thesis-wise).
 *   TRUE_HOLD  — the opportunity evaporated/reversed; holding was right.
 *   NEUTRAL_HOLD — inside the noise band; no lesson either way.
 * These judge the THESIS, never the decision's risk correctness.
 */
export type CounterfactualLabel = "TRUE_HOLD" | "FALSE_HOLD" | "NEUTRAL_HOLD";

export type JournalEntry = {
  /** ms epoch. */
  ts: number;
  kind: JournalKind;
  strategy?: BotStrategy | string;
  mode?: "paper" | "live";

  /** decision entries */
  decision?: "buy" | "sell" | "swap" | "arb" | "hold" | "skip" | "stop" | "error";
  /** Human reason, capped at MAX_REASON_LEN. */
  reason?: string;
  priceUsd?: number;

  /** gate entries */
  gate?: "entry" | "swap" | "growth";
  pass?: boolean;
  /** 1-based gate-attempt index within the tick (candidate fallback). */
  attempt?: number;
  expectedOut?: number;
  guaranteedOut?: number;
  /** Exact net percent measured on the fresh venue quote. */
  netPct?: number;
  exactness?: string;
  verifyMs?: number;
  /** The LOCAL CP model's expected output — pair with expectedOut (venue) to
   *  measure model-vs-venue drift, the live answer to "is CP discovery good
   *  enough or do we need tick-level CLMM discovery?" */
  modelOut?: number;

  /** execution entries */
  action?: "buy" | "sell" | "swap" | "arb" | "rebalance";
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: number;
  actualOut?: number;
  txid?: string;
  status?: "confirmed" | "included" | "unknown" | "paper";
  pnlUsd?: number;
  latencyMs?: number;

  /** calibration entries */
  predEdgePct?: number;
  realEdgePct?: number;

  /* ---------------- Phase 2: learning-structured fields ---------------- */
  /** Correlates every entry produced inside one bot evaluation cycle. */
  cycleId?: string;
  /** Route pool ids (structured — never parsed out of reason strings). */
  poolIds?: number[];
  /** Venue set touched by the route. */
  venues?: string[];
  /** Route path signature (kind:pool>pool>…), amount-independent. */
  routeSig?: string;
  /** USD notional of the candidate/execution. */
  sizeUsd?: number;
  /** Number of route legs. */
  hops?: number;
  /** Engine's regime classification at decision time. */
  regime?: string;
  /** Realized vol per print at decision time, percent. */
  volPct?: number;
  /** Unified danger score at decision time. */
  dangerScore?: number;
  /** Modeled execution probability 0–1. */
  execProb?: number;
  /** Failure class from the trade taxonomy (RPC_FAILURE, MIN_OUT_FAILED, …). */
  failureClass?: string;
  /** Platform fee (0.001% to smart.ass) appended to this execution's tx. */
  platformFeeAmount?: number;
  platformFeeToken?: string;
  /** True ONLY once the chain confirms; absent on unknown/failed/paper. */
  platformFeeCollected?: boolean;
  /** Realized slippage: (1 − actualOut/expectedOut) × 100, confirmed fills. */
  realizedSlipPct?: number;
  /** Pool spot move around our own confirmed fill, percent (signed). */
  selfImpactPct?: number;

  /** counterfactual entries */
  cfLabel?: CounterfactualLabel;
  /** Counterfactual net outcome of the skipped opportunity, percent. */
  cfPct?: number;
  /** How the counterfactual was measured: price mark, local re-quote, or the real trade tape. */
  cfModel?: "mark" | "requote" | "tape";
  /** The HOLD reason class being judged. */
  holdReasonClass?: string;

  /** learning entries (artifact lifecycle: proposed/shadow/promoted/rolled_back/expired) */
  artifactId?: string;
  artifactType?: string;
  artifactStatus?: string;
  artifactValue?: number;
  previousValue?: number;
  samples?: number;
  confidence?: number;

  /** compact market context (scalars only) */
  leefUsd?: number;
  waxUsd?: number;

  /**
   * "backfill" = imported from chain history, not observed live. Carries no
   * predicted values (unknowable in hindsight) and never feeds learning
   * profiles — it exists for the audit trail, the desk and the AI review.
   */
  source?: "backfill";
};

/* ------------------------------------------------------------------ */
/* Cycle correlation                                                    */
/* ------------------------------------------------------------------ */

/** Set by the bot loop at the start of each evaluation cycle. */
let currentCycleId: string | null = null;
export function setJournalCycleId(id: string | null): void {
  currentCycleId = id;
}

/** Live listeners — the learning store folds every entry into profiles. */
type JournalListener = (e: JournalEntry) => void;
const listeners = new Set<JournalListener>();
export function onJournalEntry(fn: JournalListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const DB_NAME = "leef-evidence";
const STORE = "journal";
/** Route-scoped market fixtures for replay (Phase 3 seed). */
const FIXTURE_STORE = "fixtures";
/** Fixtures are ~1–2KB each; 2000 ≈ a few MB — bounded like the journal. */
export const MAX_FIXTURES = 2_000;
/** Hard storage bound. ~60k compact entries ≈ 15–25 MB worst case. */
export const MAX_ENTRIES = 60_000;
/** Prune target once MAX_ENTRIES is exceeded (batch delete, not per-write). */
export const PRUNE_TO = 50_000;
const FLUSH_MS = 4_000;
const FLUSH_AT = 25;
const MAX_REASON_LEN = 240;
/** Count + prune check at most this often (both are cheap but not free). */
const PRUNE_CHECK_MS = 60_000;

/* ------------------------------------------------------------------ */
/* Pure aggregation (unit-tested; no IDB below this line is required)  */
/* ------------------------------------------------------------------ */

export type StrategyEvidence = {
  strategy: string;
  decisions: number;
  holds: number;
  errors: number;
  gatePass: number;
  gateFail: number;
  executions: number;
  confirmed: number;
  unknown: number;
  paper: number;
  wins: number;
  pnlUsd: number;
  predEdgePctSum: number;
  predN: number;
  realEdgePctSum: number;
  realN: number;
};

export type EvidenceStats = {
  entries: number;
  oldestTs: number | null;
  newestTs: number | null;
  byStrategy: StrategyEvidence[];
  /** Normalized gate-failure reasons, most frequent first. */
  topGateFails: { reason: string; count: number }[];
  /** Counterfactual HOLD tallies (Phase 2). */
  counterfactuals: { trueHolds: number; falseHolds: number; neutral: number };
  /**
   * Model↔venue drift: (venueExact / localCP − 1) over gate quotes. The live
   * answer to "is constant-product discovery good enough, or does Alcor need
   * tick-level CLMM discovery?" — small |meanAbsPct| = CP suffices.
   */
  gateDrift: { n: number; meanPct: number; meanAbsPct: number };
};

/**
 * Buckets a gate-failure reason into a stable signature: numbers and txids
 * vary per event, so group on the message shape, not the literal string.
 */
export function reasonSignature(reason: string): string {
  return reason
    .replace(/[0-9a-f]{16,}/gi, "0x…")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function blankStrategyEvidence(strategy: string): StrategyEvidence {
  return {
    strategy,
    decisions: 0,
    holds: 0,
    errors: 0,
    gatePass: 0,
    gateFail: 0,
    executions: 0,
    confirmed: 0,
    unknown: 0,
    paper: 0,
    wins: 0,
    pnlUsd: 0,
    predEdgePctSum: 0,
    predN: 0,
    realEdgePctSum: 0,
    realN: 0,
  };
}

/** Fold entries into per-strategy evidence. Input order does not matter. */
export function aggregateEntries(entries: JournalEntry[]): EvidenceStats {
  const byStrategy = new Map<string, StrategyEvidence>();
  const gateFails = new Map<string, number>();
  const counterfactuals = { trueHolds: 0, falseHolds: 0, neutral: 0 };
  const drift = { n: 0, sumPct: 0, sumAbsPct: 0 };
  let oldestTs: number | null = null;
  let newestTs: number | null = null;

  const strat = (e: JournalEntry): StrategyEvidence => {
    const key = e.strategy || "—";
    let s = byStrategy.get(key);
    if (!s) {
      s = blankStrategyEvidence(key);
      byStrategy.set(key, s);
    }
    return s;
  };

  for (const e of entries) {
    if (oldestTs == null || e.ts < oldestTs) oldestTs = e.ts;
    if (newestTs == null || e.ts > newestTs) newestTs = e.ts;
    // Analyst calls stay auditable in the raw log but never become a
    // per-strategy row — they are commentary, not trading performance.
    if (e.kind === "ai" || e.kind === "learning") continue;
    if (e.kind === "counterfactual") {
      // Counterfactuals are not decisions — tallied separately.
      if (e.cfLabel === "TRUE_HOLD") counterfactuals.trueHolds += 1;
      else if (e.cfLabel === "FALSE_HOLD") counterfactuals.falseHolds += 1;
      else counterfactuals.neutral += 1;
      continue;
    }
    const s = strat(e);
    switch (e.kind) {
      case "decision":
        s.decisions += 1;
        if (e.decision === "hold" || e.decision === "skip") s.holds += 1;
        if (e.decision === "error") s.errors += 1;
        break;
      case "gate":
        if (e.pass) s.gatePass += 1;
        else {
          s.gateFail += 1;
          const sig = reasonSignature(e.reason ?? "unknown");
          gateFails.set(sig, (gateFails.get(sig) ?? 0) + 1);
        }
        if ((e.modelOut ?? 0) > 0 && (e.expectedOut ?? 0) > 0) {
          const d = (e.expectedOut! / e.modelOut! - 1) * 100;
          drift.n += 1;
          drift.sumPct += d;
          drift.sumAbsPct += Math.abs(d);
        }
        break;
      case "execution":
        // Self-impact follow-up entries are observations, not new executions.
        if (e.amountIn == null && e.expectedOut == null && e.selfImpactPct != null) break;
        s.executions += 1;
        if (e.status === "confirmed" || e.status === "included") s.confirmed += 1;
        if (e.status === "unknown") s.unknown += 1;
        if (e.status === "paper") s.paper += 1;
        if ((e.pnlUsd ?? 0) > 0) s.wins += 1;
        s.pnlUsd += e.pnlUsd ?? 0;
        break;
      case "calibration":
        if (e.predEdgePct != null) {
          s.predEdgePctSum += e.predEdgePct;
          s.predN += 1;
        }
        s.realEdgePctSum += e.realEdgePct ?? 0;
        s.realN += 1;
        break;
    }
  }

  return {
    entries: entries.length,
    oldestTs,
    newestTs,
    byStrategy: [...byStrategy.values()].sort(
      (a, b) => b.executions - a.executions || b.decisions - a.decisions,
    ),
    topGateFails: [...gateFails.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    counterfactuals,
    gateDrift: {
      n: drift.n,
      meanPct: drift.n > 0 ? drift.sumPct / drift.n : 0,
      meanAbsPct: drift.n > 0 ? drift.sumAbsPct / drift.n : 0,
    },
  };
}

/** Serialize entries to NDJSON (one JSON object per line, input order). */
export function toNdjson(entries: JournalEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
}

/* ------------------------------------------------------------------ */
/* IndexedDB layer — lazy, buffered, fail-silent                        */
/* ------------------------------------------------------------------ */

let dbPromise: Promise<IDBDatabase | null> | null = null;
let buffer: JournalEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let lastPruneCheck = 0;
let listenersArmed = false;

function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (!idbAvailable()) {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    let settled = false;
    const done = (db: IDBDatabase | null) => {
      if (!settled) {
        settled = true;
        resolve(db);
      }
    };
    try {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        try {
          req.result.createObjectStore(STORE, { autoIncrement: true });
        } catch {
          /* store exists */
        }
        try {
          req.result.createObjectStore(FIXTURE_STORE, { autoIncrement: true });
        } catch {
          /* store exists */
        }
      };
      req.onsuccess = () => done(req.result);
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
    } catch {
      done(null);
    }
  });
  return dbPromise;
}

function armListeners(): void {
  if (listenersArmed || typeof window === "undefined") return;
  listenersArmed = true;
  window.addEventListener("beforeunload", () => void flushJournal());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushJournal();
  });
}

/**
 * Append one entry. Never throws, never blocks the caller. Drops the
 * buffer (rather than growing unbounded) if a previous flush is still
 * running — losing a few evidence rows beats stalling a trade.
 */
export function journal(entry: Omit<JournalEntry, "ts"> & { ts?: number }): void {
  try {
    const stamped: JournalEntry = {
      ...entry,
      cycleId: entry.cycleId ?? currentCycleId ?? undefined,
      reason: entry.reason ? entry.reason.slice(0, MAX_REASON_LEN) : undefined,
      ts: entry.ts ?? Date.now(),
    };
    // Live listeners (learning profiles) run even when IDB is unavailable.
    for (const l of listeners) {
      try {
        l(stamped);
      } catch {
        /* a listener must never break the journal */
      }
    }
    if (!idbAvailable()) return;
    armListeners();
    buffer.push(stamped);
    if (buffer.length >= FLUSH_AT) void flushJournal();
    else if (!flushTimer) {
      flushTimer = setTimeout(() => void flushJournal(), FLUSH_MS);
    }
  } catch {
    /* evidence must never break trading */
  }
}

/** Write buffered entries in a single transaction. Safe to call anytime. */
export async function flushJournal(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushing || buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  flushing = true;
  try {
    const db = await openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        for (const e of batch) store.add(e);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
    await maybePrune(db);
  } catch {
    /* ignore */
  } finally {
    flushing = false;
  }
}

async function maybePrune(db: IDBDatabase): Promise<void> {
  const now = Date.now();
  if (now - lastPruneCheck < PRUNE_CHECK_MS) return;
  lastPruneCheck = now;
  try {
    const count = await new Promise<number>((resolve) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    });
    if (count <= MAX_ENTRIES) return;
    const excess = count - PRUNE_TO;
    // Keys auto-increment in insertion order: delete the oldest `excess`.
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      const cursorReq = tx.objectStore(STORE).openCursor();
      let seen = 0;
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || seen >= excess) return;
        cursor.delete();
        seen += 1;
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* ignore */
  }
}

async function allEntries(): Promise<JournalEntry[]> {
  try {
    await flushJournal();
    const db = await openDb();
    if (!db) return [];
    return await new Promise<JournalEntry[]>((resolve) => {
      try {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
        req.onsuccess = () => resolve((req.result as JournalEntry[]) ?? []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  } catch {
    return [];
  }
}

/** Aggregated per-strategy evidence for the Evidence desk. */
export async function journalStats(): Promise<EvidenceStats> {
  return aggregateEntries(await allEntries());
}

/** Every entry, oldest first — the learning store rebuilds profiles from this. */
export async function journalAll(): Promise<JournalEntry[]> {
  return allEntries();
}

/** Full export as an NDJSON blob, oldest entry first. */
export async function journalExportBlob(): Promise<{ blob: Blob; count: number }> {
  const entries = await allEntries();
  return { blob: new Blob([toNdjson(entries)], { type: "application/x-ndjson" }), count: entries.length };
}

/** Wipe the journal. Trading state is untouched — this is evidence only. */
export async function journalClear(): Promise<void> {
  try {
    buffer = [];
    const db = await openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction([STORE, FIXTURE_STORE], "readwrite");
        tx.objectStore(STORE).clear();
        tx.objectStore(FIXTURE_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Market fixtures — route-scoped decision snapshots for replay          */
/* ------------------------------------------------------------------ */

/**
 * Everything the decision path knew about the CANDIDATE ROUTES' pools at
 * decision time. Deliberately route-scoped: a full universe snapshot is
 * ~11 MB and would kill storage within days; a fixture of the 1–6 involved
 * pools is ~1–2 KB and is sufficient to replay the decision path.
 */
export type FixturePool = {
  id: number;
  venue: string;
  aSym: string;
  aContract: string;
  aQty: number;
  aDec: number;
  bSym: string;
  bContract: string;
  bQty: number;
  bDec: number;
  feePct: number;
  tvlUsd: number;
};

export type FixtureCandidate = {
  routeSig: string;
  poolIds: number[];
  amountOut: number;
  /** Gate verdict when this candidate reached the exact gate. */
  pass?: boolean;
  netPct?: number;
};

export type MarketFixture = {
  ts: number;
  cycleId?: string;
  kind: "execution" | "gate_veto";
  strategy: string;
  mode: "paper" | "live";
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  /** Gate context when the fixture comes from a gate veto. */
  gate?: {
    /** Swap gates replay fully; entry gates replay route ranking only. */
    kind: "swap" | "entry" | "growth";
    expectedOut: number;
    guaranteedOut?: number;
    minNetPct?: number;
    pass: boolean;
    netPct: number;
  };
  candidates: FixtureCandidate[];
  pools: FixturePool[];
  /** symbol → USD price for involved tokens + WAX/LEEF. */
  prices: Record<string, number>;
  waxUsd: number;
  leefUsd: number;
  regime?: string;
  volPct?: number;
  dangerScore?: number;
  reason: string;
};

/** Write one fixture (fire-and-forget; fixtures are rarer than entries). */
export function journalFixture(fx: Omit<MarketFixture, "ts"> & { ts?: number }): void {
  try {
    if (!idbAvailable()) return;
    const stamped = { ...fx, cycleId: fx.cycleId ?? currentCycleId ?? undefined, ts: fx.ts ?? Date.now() };
    void (async () => {
      const db = await openDb();
      if (!db) return;
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(FIXTURE_STORE, "readwrite");
          tx.objectStore(FIXTURE_STORE).add(stamped);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
      // Prune occasionally (amortized — count is cheap).
      if (Math.random() < 0.05) {
        try {
          const count = await new Promise<number>((resolve) => {
            const req = db.transaction(FIXTURE_STORE, "readonly").objectStore(FIXTURE_STORE).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(0);
          });
          if (count > MAX_FIXTURES) {
            const excess = count - MAX_FIXTURES + 250;
            await new Promise<void>((resolve) => {
              const tx = db.transaction(FIXTURE_STORE, "readwrite");
              const cursorReq = tx.objectStore(FIXTURE_STORE).openCursor();
              let seen = 0;
              cursorReq.onsuccess = () => {
                const c = cursorReq.result;
                if (!c || seen >= excess) return;
                c.delete();
                seen += 1;
                c.continue();
              };
              tx.oncomplete = () => resolve();
              tx.onerror = () => resolve();
              tx.onabort = () => resolve();
            });
          }
        } catch {
          /* ignore */
        }
      }
    })();
  } catch {
    /* fixtures must never break trading */
  }
}

/** Newest-first fixtures for the replay desk. */
export async function listFixtures(limit = 50): Promise<MarketFixture[]> {
  try {
    const db = await openDb();
    if (!db) return [];
    return await new Promise<MarketFixture[]>((resolve) => {
      try {
        const req = db.transaction(FIXTURE_STORE, "readonly").objectStore(FIXTURE_STORE).getAll();
        req.onsuccess = () => {
          const all = (req.result as MarketFixture[]) ?? [];
          resolve(all.sort((a, b) => b.ts - a.ts).slice(0, Math.max(1, limit)));
        };
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  } catch {
    return [];
  }
}
