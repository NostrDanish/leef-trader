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

export type JournalKind = "decision" | "gate" | "execution" | "calibration";

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

  /** execution entries */
  action?: "buy" | "sell" | "swap" | "arb";
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

  /** compact market context (scalars only) */
  leefUsd?: number;
  waxUsd?: number;
};

const DB_NAME = "leef-evidence";
const STORE = "journal";
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
        break;
      case "execution":
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
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        try {
          req.result.createObjectStore(STORE, { autoIncrement: true });
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
    if (!idbAvailable()) return;
    armListeners();
    const reason = entry.reason;
    buffer.push({
      ...entry,
      reason: reason ? reason.slice(0, MAX_REASON_LEN) : undefined,
      ts: entry.ts ?? Date.now(),
    });
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
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).clear();
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
