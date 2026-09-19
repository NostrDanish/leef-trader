/**
 * Learning core — deterministic statistics over the evidence journal.
 *
 * NO AI in this file. NO signing. NO trade-path authority. This module turns
 * journaled evidence into bounded, inspectable adjustments:
 *
 *   journal entries (truth)
 *     → PoolProfile / RouteProfile (incremental aggregates, size-bucketed)
 *     → learned slippage estimate (min samples, clamped, decayed)
 *     → learned size multiplier (≤ 1 — learning can only shrink ceilings)
 *     → LearningArtifact proposals (typed, schema-checked)
 *     → LearningGovernor (reject / shadow / promote / rollback)
 *
 * Design rules (from docs/AI_LEARNING_SIZE_AUDIT.md):
 *   - Historical learning is an ADJUSTMENT layer. Live market math stays
 *     authoritative; learning never replaces AMM pricing or the exact gate.
 *   - Infrastructure failures (RPC/rate-limit/venue/CPU/policy) NEVER feed
 *     market-model statistics (slippage, edge, size curves).
 *   - Below the sample floor, the deterministic model is used unchanged.
 *   - Every artifact has expiry; every promotion is reversible.
 */

import { isEconomicFailureCode } from "@/lib/wallet/trade-error";
import type { CounterfactualLabel, JournalEntry } from "./journal";

/* ------------------------------------------------------------------ */
/* Configuration                                                        */
/* ------------------------------------------------------------------ */

export type LearningConfig = {
  /** Min confirmed samples before a learned slippage estimate applies. */
  minSamplesSlippage: number;
  /** Min samples before a size curve may shrink the size ceiling. */
  minSamplesSizeCurve: number;
  /** Min samples inside a bucket before that bucket is "known". */
  minSamplesBucket: number;
  /** EWMA half-life for slippage/edge-error — stale evidence fades. */
  halfLifeMs: number;
  /** Profile with no fresh sample in this window is ignored entirely. */
  staleAfterMs: number;
  /** Learned slippage estimate clamp (percent). */
  slipClampMinPct: number;
  slipClampMaxPct: number;
  /** Learned size multiplier clamp — NEVER above 1 (learning shrinks only). */
  sizeMultMin: number;
  sizeMultMax: number;
  /** Shadow samples required before an artifact may promote. */
  shadowMinSamples: number;
  /** Promotion requires learned error ≤ baseline × this factor. */
  promoteErrorRatio: number;
  /** Artifact lifetime. */
  artifactTtlMs: number;
};

export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  minSamplesSlippage: 8,
  minSamplesSizeCurve: 12,
  minSamplesBucket: 3,
  halfLifeMs: 3 * 86_400_000,
  staleAfterMs: 14 * 86_400_000,
  slipClampMinPct: 0.02,
  slipClampMaxPct: 0.75,
  sizeMultMin: 0.5,
  sizeMultMax: 1,
  shadowMinSamples: 6,
  promoteErrorRatio: 0.95,
  artifactTtlMs: 7 * 86_400_000,
};

/* ------------------------------------------------------------------ */
/* Size buckets (USD)                                                   */
/* ------------------------------------------------------------------ */

export const SIZE_BUCKET_EDGES = [0.25, 0.5, 1, 2, 5, 10, 25];
export const SIZE_BUCKET_LABELS = [
  "<$0.25",
  "$0.25–0.50",
  "$0.50–1",
  "$1–2",
  "$2–5",
  "$5–10",
  "$10–25",
  ">$25",
];

export function sizeBucketIndex(sizeUsd: number): number {
  for (let i = 0; i < SIZE_BUCKET_EDGES.length; i++) {
    if (sizeUsd < SIZE_BUCKET_EDGES[i]!) return i;
  }
  return SIZE_BUCKET_EDGES.length;
}

/* ------------------------------------------------------------------ */
/* Profiles                                                             */
/* ------------------------------------------------------------------ */

export type BucketStats = {
  samples: number;
  confirmed: number;
  /** Sum of realized slippage (percent) on confirmed fills. */
  slipPctSum: number;
  /** Sum of realized edge (percent) — only over edgeN entries with edge data. */
  edgePctSum: number;
  edgeN: number;
  /** Sum of predicted edge (percent) — error = edge − pred. */
  predEdgePctSum: number;
  /** Sum of signed pool spot move after our fills (self-impact), percent. */
  selfImpactPctSum: number;
  selfImpactN: number;
  /** Economic failures (market lessons). */
  econFails: number;
  /** Infrastructure failures (never market lessons). */
  infraFails: number;
};

export type RegimeStats = {
  samples: number;
  confirmed: number;
  slipPctSum: number;
  edgePctSum: number;
  edgeN: number;
};

export type Profile = {
  /** "pool:alcor:217" or "route:hop:1713>1656>217". */
  key: string;
  kind: "pool" | "route";
  label: string;
  venue: string;
  firstSeen: number;
  lastSeen: number;
  /** Total executions observed (any status). */
  executions: number;
  gateFails: number;
  /** Time-decayed mean realized slippage, percent (null until 1st sample). */
  ewmaSlipPct: number | null;
  ewmaSlipAt: number;
  /** Time-decayed mean edge error (realized − predicted), percent. */
  ewmaEdgeErrPct: number | null;
  ewmaEdgeErrAt: number;
  buckets: BucketStats[];
  /** Per-regime breakdown — a pool does not behave the same in every tape. */
  byRegime: Record<string, RegimeStats>;
  /** Per-strategy breakdown — one strategy's record never teaches another. */
  byStrategy: Record<string, RegimeStats>;
};

export type LearningProfiles = Record<string, Profile>;

const blankBucket = (): BucketStats => ({
  samples: 0,
  confirmed: 0,
  slipPctSum: 0,
  edgePctSum: 0,
  edgeN: 0,
  predEdgePctSum: 0,
  selfImpactPctSum: 0,
  selfImpactN: 0,
  econFails: 0,
  infraFails: 0,
});

/** Mean realized edge — null when NO entry carried edge data (0 ≠ unknown). */
export function bucketMeanEdge(b: BucketStats): number | null {
  return b.edgeN > 0 ? b.edgePctSum / b.edgeN : null;
}

function ewmaStep(
  prev: number | null,
  prevAt: number,
  value: number,
  now: number,
  halfLifeMs: number,
): number {
  if (prev == null || !(prevAt > 0)) return value;
  const dt = Math.max(0, now - prevAt);
  // Weight of the OLD aggregate decays with elapsed time.
  const wOld = Math.pow(0.5, dt / Math.max(1, halfLifeMs));
  return prev * wOld + value * (1 - wOld);
}

export function isProfileStale(p: Profile, now: number, cfg: LearningConfig): boolean {
  return now - p.lastSeen > cfg.staleAfterMs;
}

/** Pool key for the route's PRIMARY (first-leg) pool. */
export function poolKeyOf(venue: string, poolId: number): string {
  return `pool:${venue}:${poolId}`;
}

export function routeKeyOf(routeSig: string): string {
  return `route:${routeSig}`;
}

function profileFor(
  profiles: LearningProfiles,
  key: string,
  kind: "pool" | "route",
  label: string,
  venue: string,
  now: number,
): Profile {
  let p = profiles[key];
  if (!p) {
    p = {
      key,
      kind,
      label,
      venue,
      firstSeen: now,
      lastSeen: now,
      executions: 0,
      gateFails: 0,
      ewmaSlipPct: null,
      ewmaSlipAt: 0,
      ewmaEdgeErrPct: null,
      ewmaEdgeErrAt: 0,
      buckets: Array.from({ length: SIZE_BUCKET_EDGES.length + 1 }, blankBucket),
      byRegime: {},
      byStrategy: {},
    };
    profiles[key] = p;
  }
  p.lastSeen = Math.max(p.lastSeen, now);
  return p;
}

/* ------------------------------------------------------------------ */
/* Learning from journal entries                                        */
/* ------------------------------------------------------------------ */

/** Is this failure class infrastructure noise (never a market lesson)? */
export function isInfraFailure(cls: string | undefined): boolean {
  if (!cls) return false;
  return !isEconomicFailureCode(cls) && cls !== "UNKNOWN";
}

function venuesOf(e: JournalEntry): string[] {
  return e.venues && e.venues.length > 0 ? e.venues : ["alcor"];
}

function primaryVenue(e: JournalEntry): string {
  return venuesOf(e)[0] ?? "alcor";
}

function labelsFor(e: JournalEntry): { poolLabel: string; routeLabel: string } {
  const pair = `${e.tokenIn ?? "?"}→${e.tokenOut ?? "?"}`;
  const pools = e.poolIds?.length ? `#${e.poolIds.join(">#")}` : "—";
  return { poolLabel: `${pair} · ${pools}`, routeLabel: `${pair} · ${pools}` };
}

/**
 * Fold one journal entry into the profile set. Only execution/gate/
 * counterfactual entries carry learning signal; decisions/calibrations/ai
 * are context. Infrastructure failures update failure counts ONLY.
 */
export function applyEntry(profiles: LearningProfiles, e: JournalEntry, cfg: LearningConfig): void {
  // Backfilled history has no predictions — it must never teach profiles.
  if (e.source === "backfill") return;
  const now = e.ts;
  if (e.kind === "execution" && e.poolIds?.length) {
    const { poolLabel } = labelsFor(e);
    const pool = profileFor(
      profiles,
      poolKeyOf(primaryVenue(e), e.poolIds[0]!),
      "pool",
      poolLabel,
      primaryVenue(e),
      now,
    );
    const route = e.routeSig
      ? profileFor(profiles, routeKeyOf(e.routeSig), "route", poolLabel, venuesOf(e).join("+"), now)
      : null;
    for (const p of route ? [pool, route] : [pool]) {
      p.executions += 1;
      const b = p.buckets[sizeBucketIndex(e.sizeUsd ?? 0)]!;
      b.samples += 1;
      // Regime dimension: calm and volatile tapes are different pools.
      // Strategy dimension: one engine's evidence never teaches another.
      for (const [dim, key] of [
        [p.byRegime, e.regime],
        [p.byStrategy, e.strategy],
      ] as const) {
        if (!key) continue;
        const ds = (dim[key] ??= {
          samples: 0,
          confirmed: 0,
          slipPctSum: 0,
          edgePctSum: 0,
          edgeN: 0,
        });
        ds.samples += 1;
        if (e.status === "confirmed" && (e.expectedOut ?? 0) > 0 && (e.actualOut ?? 0) > 0) {
          ds.confirmed += 1;
          ds.slipPctSum += (1 - e.actualOut! / e.expectedOut!) * 100;
          if (e.predEdgePct != null && e.realEdgePct != null) {
            ds.edgePctSum += e.realEdgePct;
            ds.edgeN += 1;
          }
        }
      }
      if (
        e.status === "confirmed" &&
        (e.expectedOut ?? 0) > 0 &&
        (e.actualOut ?? 0) > 0
      ) {
        b.confirmed += 1;
        const slip = (1 - e.actualOut! / e.expectedOut!) * 100;
        b.slipPctSum += slip;
        p.ewmaSlipPct = ewmaStep(p.ewmaSlipPct, p.ewmaSlipAt, slip, now, cfg.halfLifeMs);
        p.ewmaSlipAt = now;
        if (e.predEdgePct != null && e.realEdgePct != null) {
          const err = e.realEdgePct - e.predEdgePct;
          b.edgePctSum += e.realEdgePct;
          b.edgeN += 1;
          b.predEdgePctSum += e.predEdgePct;
          p.ewmaEdgeErrPct = ewmaStep(
            p.ewmaEdgeErrPct,
            p.ewmaEdgeErrAt,
            err,
            now,
            cfg.halfLifeMs,
          );
          p.ewmaEdgeErrAt = now;
        }
      }
      if (e.selfImpactPct != null) {
        b.selfImpactPctSum += e.selfImpactPct;
        b.selfImpactN += 1;
      }
      if (e.failureClass) {
        if (isInfraFailure(e.failureClass)) b.infraFails += 1;
        else b.econFails += 1;
      }
    }
    return;
  }
  if (e.kind === "gate" && e.pass === false && e.poolIds?.length) {
    const venue = primaryVenue(e);
    const pool = profileFor(
      profiles,
      poolKeyOf(venue, e.poolIds[0]!),
      "pool",
      labelsFor(e).poolLabel,
      venue,
      now,
    );
    pool.gateFails += 1;
    return;
  }
}

/** Rebuild all profiles from a journal scan (boot path). */
export function rebuildProfiles(entries: JournalEntry[], cfg: LearningConfig): LearningProfiles {
  const profiles: LearningProfiles = {};
  for (const e of entries) applyEntry(profiles, e, cfg);
  return profiles;
}

/* ------------------------------------------------------------------ */
/* Learned outputs (bounded adjustments into the deterministic engine)   */
/* ------------------------------------------------------------------ */

/**
 * Learned slippage estimate for a pool at a size, percent. Null unless the
 * pool has enough confirmed evidence and is fresh — the deterministic
 * cost model is the fallback and stays authoritative.
 */
export function learnedSlippagePct(
  p: Profile | null,
  sizeUsd: number,
  now: number,
  cfg: LearningConfig,
): number | null {
  if (!p || isProfileStale(p, now, cfg)) return null;
  // Confirmed samples across the target bucket and its neighbors (the curve
  // is smooth; adjacent buckets inform each other with halved weight).
  const idx = sizeBucketIndex(sizeUsd);
  let wSum = 0;
  let acc = 0;
  for (const [off, w] of [[0, 1], [-1, 0.5], [1, 0.5]] as const) {
    const b = p.buckets[idx + off];
    if (!b || b.confirmed === 0) continue;
    wSum += w * b.confirmed;
    acc += w * b.slipPctSum;
  }
  if (wSum < cfg.minSamplesSlippage) return null;
  const mean = acc / Math.max(1e-9, wSum);
  return Math.min(cfg.slipClampMaxPct, Math.max(cfg.slipClampMinPct, mean));
}

/**
 * Learned size multiplier for a candidate of `sizeUsd`, ≤ 1 always.
 * Finds the first size bucket with enough samples whose mean realized edge
 * is negative; sizes at/above that bucket get scaled toward the largest
 * historically good bucket. Never scales up, never below sizeMultMin.
 */
export function learnedSizeMultiplier(
  p: Profile | null,
  sizeUsd: number,
  now: number,
  cfg: LearningConfig,
): number {
  if (!p || isProfileStale(p, now, cfg)) return 1;
  const total = p.buckets.reduce((s, b) => s + b.confirmed, 0);
  if (total < cfg.minSamplesSizeCurve) return 1;
  const idx = sizeBucketIndex(sizeUsd);
  // Largest bucket with a proven non-negative mean edge.
  let lastGoodEdge = SIZE_BUCKET_EDGES[0]! / 2; // below the first bucket
  for (let i = 0; i < p.buckets.length; i++) {
    const b = p.buckets[i]!;
    if (b.confirmed < cfg.minSamplesBucket) continue;
    const mean = bucketMeanEdge(b);
    if (mean != null && mean >= 0) {
      lastGoodEdge = i === 0 ? SIZE_BUCKET_EDGES[0]! / 2 : SIZE_BUCKET_EDGES[i - 1]!;
    } else if (mean != null && mean < 0 && i <= idx) {
      // Candidate sits in/at a bucket with proven negative edge: scale down
      // to the largest historically good size.
      const mult = lastGoodEdge / Math.max(sizeUsd, 1e-9);
      return Math.min(cfg.sizeMultMax, Math.max(cfg.sizeMultMin, mult));
    }
  }
  return 1;
}

/* ------------------------------------------------------------------ */
/* Counterfactual HOLD evaluation                                       */
/* ------------------------------------------------------------------ */

export type PendingCounterfactual = {
  id: string;
  registeredAt: number;
  /** Evaluate once now ≥ registeredAt + horizonMs. */
  horizonMs: number;
  /**
   * entry = directional thesis (judged by the price mark);
   * swap  = immediate-conversion path/cycle (judged by re-quoting the book).
   */
  cfKind: "entry" | "swap";
  strategy: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  sizeUsd: number;
  poolIds: number[];
  venues: string[];
  routeSig?: string;
  /** Predicted net edge of the skipped opportunity, percent. */
  predNetPct: number;
  /** Modeled round-trip cost at registration (charged to the counterfactual). */
  costsPct: number;
  /** USD mark of tokenOut at registration. */
  entryMarkUsd: number;
  /** HOLD reason (class) being judged. */
  holdReasonClass: string;
  regime?: string;
  volPct?: number;
  dangerScore?: number;
};

/** Minimum |cfPct| that counts as a lesson — inside this band is noise. */
export const CF_NOISE_BAND_PCT = 0.15;

export function labelCounterfactual(cfPct: number): CounterfactualLabel {
  if (cfPct >= CF_NOISE_BAND_PCT) return "FALSE_HOLD";
  if (cfPct <= -CF_NOISE_BAND_PCT) return "TRUE_HOLD";
  return "NEUTRAL_HOLD";
}

/**
 * Mark-based counterfactual for skipped entries: the thesis was "tokenOut
 * appreciates" — the counterfactual P&L is the realized mark move minus the
 * round-trip cost we modeled at the time. Labeled "mark": it measures the
 * thesis, not a guaranteed fill.
 */
export function counterfactualFromMark(
  cf: PendingCounterfactual,
  nowMarkUsd: number,
): { cfPct: number; label: CounterfactualLabel } | null {
  if (!(cf.entryMarkUsd > 0) || !(nowMarkUsd > 0)) return null;
  const cfPct = ((nowMarkUsd / cf.entryMarkUsd - 1) * 100) - cf.costsPct;
  return { cfPct, label: labelCounterfactual(cfPct) };
}

/**
 * Requote-based counterfactual for skipped swaps/cycles: re-rank the same
 * pair on the current book and measure the net pct now. Labeled "requote"
 * (local CP math — model-based, not a venue quote).
 */
export function counterfactualFromNetPct(
  cfPct: number,
): { cfPct: number; label: CounterfactualLabel } {
  return { cfPct, label: labelCounterfactual(cfPct) };
}

/* ------------------------------------------------------------------ */
/* Learning artifacts + the deterministic governor                      */
/* ------------------------------------------------------------------ */

export type ArtifactType = "POOL_SLIPPAGE_PROFILE" | "POOL_SIZE_MULTIPLIER";

export type LearningArtifact = {
  /** Deterministic id: type:scopeKey. */
  id: string;
  type: ArtifactType;
  /** Pool key this artifact scopes to. */
  scopeKey: string;
  /** The proposed value (slippage pct, or size multiplier ≤ 1). */
  value: number;
  /** The deterministic default it replaces. */
  previousValue: number;
  /** Absolute clamp on |value − previousValue|. */
  maxAllowedChange: number;
  samples: number;
  /** 0–1, from sample count (approaches 1 asymptotically). */
  confidence: number;
  createdAt: number;
  expiresAt: number;
  status: "shadow" | "active" | "rejected" | "rolled_back" | "expired";
  /**
   * Shadow evidence. Slippage artifacts: prediction errors (baseline vs
   * learned). Size-multiplier artifacts: baselineErrSum accumulates the
   * REALIZED edge of confirmed fills landing in watchBucket (the destructive
   * bucket), n counts them — the shadow question is "did the destructive
   * bucket stay destructive?".
   */
  shadow: { n: number; baselineErrSum: number; learnedErrSum: number };
  /** Size artifacts only: the bucket index being watched. */
  watchBucket?: number;
};

export type GovernorDecision = {
  action: "reject" | "shadow" | "promote" | "rollback" | "expire" | "keep";
  reason: string;
};

export function confidenceFromSamples(samples: number, minSamples: number): number {
  if (samples < minSamples) return 0;
  // Saturating curve: minSamples → ~0.5, 4× minSamples → ~0.8, …
  return Math.min(0.99, 1 - minSamples / (samples + minSamples));
}

/** Deterministic proposal from a profile. Null when evidence is too weak. */
export function proposeArtifacts(
  p: Profile,
  now: number,
  cfg: LearningConfig,
  defaults: { slippagePct: number },
): LearningArtifact[] {
  if (p.kind !== "pool" || isProfileStale(p, now, cfg)) return [];
  const out: LearningArtifact[] = [];
  const confirmed = p.buckets.reduce((s, b) => s + b.confirmed, 0);

  if (p.ewmaSlipPct != null && confirmed >= cfg.minSamplesSlippage) {
    const value = Math.min(
      cfg.slipClampMaxPct,
      Math.max(cfg.slipClampMinPct, p.ewmaSlipPct),
    );
    out.push({
      id: `POOL_SLIPPAGE_PROFILE:${p.key}`,
      type: "POOL_SLIPPAGE_PROFILE",
      scopeKey: p.key,
      value,
      previousValue: defaults.slippagePct,
      maxAllowedChange: cfg.slipClampMaxPct,
      samples: confirmed,
      confidence: confidenceFromSamples(confirmed, cfg.minSamplesSlippage),
      createdAt: now,
      expiresAt: now + cfg.artifactTtlMs,
      status: "shadow",
      shadow: { n: 0, baselineErrSum: 0, learnedErrSum: 0 },
    });
  }

  const total = p.buckets.reduce((s, b) => s + b.confirmed, 0);
  if (total >= cfg.minSamplesSizeCurve) {
    // Find the first destructive bucket; multiplier targets the largest
    // proven good size (still only meaningful for sizes at/above it).
    let mult = 1;
    let destructiveIdx = -1;
    for (let i = 0; i < p.buckets.length; i++) {
      const b = p.buckets[i]!;
      if (b.confirmed < cfg.minSamplesBucket) continue;
      const mean = bucketMeanEdge(b);
      if (mean != null && mean < 0) {
        const goodEdge = i === 0 ? SIZE_BUCKET_EDGES[0]! / 2 : SIZE_BUCKET_EDGES[i - 1]!;
        // Reference size: the middle of the destructive bucket.
        const ref = i === 0 ? SIZE_BUCKET_EDGES[0]! / 2 : (SIZE_BUCKET_EDGES[i - 1]! + (SIZE_BUCKET_EDGES[i] ?? 2 * SIZE_BUCKET_EDGES[i - 1]!)) / 2;
        mult = Math.min(cfg.sizeMultMax, Math.max(cfg.sizeMultMin, goodEdge / Math.max(ref, 1e-9)));
        destructiveIdx = i;
        break;
      }
    }
    if (mult < 1 && destructiveIdx > 0) {
      out.push({
        id: `POOL_SIZE_MULTIPLIER:${p.key}`,
        type: "POOL_SIZE_MULTIPLIER",
        scopeKey: p.key,
        value: mult,
        previousValue: 1,
        maxAllowedChange: 1 - cfg.sizeMultMin,
        samples: total,
        confidence: confidenceFromSamples(total, cfg.minSamplesSizeCurve),
        createdAt: now,
        expiresAt: now + cfg.artifactTtlMs,
        status: "shadow",
        shadow: { n: 0, baselineErrSum: 0, learnedErrSum: 0 },
        watchBucket: destructiveIdx,
      });
    }
  }
  return out;
}

/**
 * The LearningGovernor. Deterministic authority over every artifact —
 * validity, evidence, clamps, expiry, shadow proof. The AI never decides
 * this; statistics do.
 */
export function governArtifact(
  a: LearningArtifact,
  now: number,
  cfg: LearningConfig,
): GovernorDecision {
  if (!a.id || a.id !== `${a.type}:${a.scopeKey}`) {
    return { action: "reject", reason: "schema: id must be type:scopeKey" };
  }
  if (!Number.isFinite(a.value)) return { action: "reject", reason: "schema: value not finite" };
  if (a.type === "POOL_SIZE_MULTIPLIER" && (a.value > cfg.sizeMultMax || a.value < cfg.sizeMultMin)) {
    return { action: "reject", reason: `clamp: multiplier ${a.value} outside [${cfg.sizeMultMin}, ${cfg.sizeMultMax}]` };
  }
  if (a.type === "POOL_SLIPPAGE_PROFILE" && (a.value < 0 || a.value > cfg.slipClampMaxPct)) {
    return { action: "reject", reason: `clamp: slippage ${a.value} outside [0, ${cfg.slipClampMaxPct}]` };
  }
  if (Math.abs(a.value - a.previousValue) > a.maxAllowedChange + 1e-12) {
    return { action: "reject", reason: "clamp: change exceeds maxAllowedChange" };
  }
  if (now >= a.expiresAt) return { action: "expire", reason: "artifact expired" };
  const minSamples =
    a.type === "POOL_SLIPPAGE_PROFILE" ? cfg.minSamplesSlippage : cfg.minSamplesSizeCurve;
  if (a.samples < minSamples) {
    return { action: "reject", reason: `evidence: ${a.samples} samples < ${minSamples}` };
  }
  if (a.confidence <= 0) return { action: "reject", reason: "confidence: 0" };

  if (a.type === "POOL_SIZE_MULTIPLIER") {
    // Shadow question for size artifacts: did the destructive bucket stay
    // destructive on FRESH evidence? baselineErrSum accumulates the realized
    // edge of confirmed fills landing in watchBucket; n counts them.
    const freshN = a.shadow.n;
    if (freshN < cfg.shadowMinSamples) {
      return { action: "keep", reason: `shadow: ${freshN}/${cfg.shadowMinSamples} fresh samples in watched bucket` };
    }
    const meanEdge = a.shadow.baselineErrSum / freshN;
    if (a.status === "shadow") {
      if (meanEdge < 0) {
        return {
          action: "promote",
          reason: `shadow: bucket stayed destructive (mean realized edge ${meanEdge.toFixed(2)}% over ${freshN} fresh samples)`,
        };
      }
      return {
        action: "rollback",
        reason: `shadow: bucket recovered (mean realized edge +${meanEdge.toFixed(2)}%) — proposal void`,
      };
    }
    if (a.status === "active") {
      if (meanEdge >= 0) {
        return {
          action: "rollback",
          reason: `active size artifact: bucket recovered (mean ${meanEdge.toFixed(2)}%) — reverting to the default ceiling`,
        };
      }
      return { action: "keep", reason: "active size artifact: bucket still destructive" };
    }
  }

  if (a.status === "shadow") {
    if (a.shadow.n >= cfg.shadowMinSamples) {
      const baseErr = a.shadow.baselineErrSum / a.shadow.n;
      const learnedErr = a.shadow.learnedErrSum / a.shadow.n;
      if (learnedErr <= baseErr * cfg.promoteErrorRatio) {
        return {
          action: "promote",
          reason: `shadow: learned error ${learnedErr.toFixed(3)} beats baseline ${baseErr.toFixed(3)} over ${a.shadow.n} samples`,
        };
      }
      if (learnedErr > baseErr * 1.1) {
        return {
          action: "rollback",
          reason: `shadow: learned error ${learnedErr.toFixed(3)} worse than baseline ${baseErr.toFixed(3)} — never promote`,
        };
      }
    }
    return { action: "keep", reason: `shadow: ${a.shadow.n}/${cfg.shadowMinSamples} samples` };
  }

  if (a.status === "active") {
    if (a.shadow.n >= cfg.shadowMinSamples) {
      const baseErr = a.shadow.baselineErrSum / a.shadow.n;
      const learnedErr = a.shadow.learnedErrSum / a.shadow.n;
      if (learnedErr > baseErr * 1.1) {
        return {
          action: "rollback",
          reason: `active artifact regressed: learned ${learnedErr.toFixed(3)} vs baseline ${baseErr.toFixed(3)}`,
        };
      }
    }
    return { action: "keep", reason: "active and healthy" };
  }

  return { action: "keep", reason: `status ${a.status}` };
}

/** Revert an artifact to its deterministic default. */
export function rollbackArtifact(a: LearningArtifact): LearningArtifact {
  return { ...a, value: a.previousValue, status: "rolled_back" };
}

/* ------------------------------------------------------------------ */
/* AI-proposed artifacts (defensive parse — discovery, never authority) */
/* ------------------------------------------------------------------ */

const AI_ARTIFACT_TYPES = new Set<ArtifactType>([
  "POOL_SLIPPAGE_PROFILE",
  "POOL_SIZE_MULTIPLIER",
]);

/**
 * Extract typed artifact proposals from an analyst's JSON response. The AI
 * may ONLY propose within the typed schema, only for pools that have real
 * evidence (scopeKey must be an existing profile), and only finite values —
 * every result still goes through governArtifact, which enforces clamps,
 * sample floors and expiry. Garbage in → nothing out.
 */
export function extractLearningArtifacts(
  content: unknown,
  profiles: LearningProfiles,
  now: number,
  cfg: LearningConfig,
  defaults: { slippagePct: number },
): LearningArtifact[] {
  const list = (content as { learning_artifacts?: unknown } | null)?.learning_artifacts;
  if (!Array.isArray(list)) return [];
  const out: LearningArtifact[] = [];
  for (const raw of list) {
    const o = raw as {
      type?: unknown;
      scopeKey?: unknown;
      value?: unknown;
      confidence?: unknown;
      reason?: unknown;
    };
    if (typeof o?.type !== "string" || !AI_ARTIFACT_TYPES.has(o.type as ArtifactType)) continue;
    const type = o.type as ArtifactType;
    const scopeKey = typeof o.scopeKey === "string" ? o.scopeKey : "";
    const profile = profiles[scopeKey];
    if (!profile) continue; // AI may only scope to pools with real evidence
    if (typeof o.value !== "number" || !Number.isFinite(o.value)) continue;
    const value =
      type === "POOL_SIZE_MULTIPLIER"
        ? Math.min(cfg.sizeMultMax, Math.max(cfg.sizeMultMin, o.value))
        : Math.min(cfg.slipClampMaxPct, Math.max(cfg.slipClampMinPct, o.value));
    const samples = profile.buckets.reduce((s, b) => s + b.confirmed, 0);
    let watchBucket: number | undefined;
    if (type === "POOL_SIZE_MULTIPLIER") {
      const idx = profile.buckets.findIndex(
        (b, i) => i > 0 && b.confirmed >= cfg.minSamplesBucket && (bucketMeanEdge(b) ?? 0) < 0,
      );
      if (idx < 0) continue; // no destructive bucket — nothing to shadow-watch
      watchBucket = idx;
    }
    out.push({
      id: `${type}:${scopeKey}`,
      type,
      scopeKey,
      value,
      previousValue: type === "POOL_SIZE_MULTIPLIER" ? 1 : defaults.slippagePct,
      maxAllowedChange:
        type === "POOL_SIZE_MULTIPLIER" ? 1 - cfg.sizeMultMin : cfg.slipClampMaxPct,
      samples,
      confidence: confidenceFromSamples(samples, cfg.minSamplesSlippage),
      createdAt: now,
      expiresAt: now + cfg.artifactTtlMs,
      status: "shadow",
      shadow: { n: 0, baselineErrSum: 0, learnedErrSum: 0 },
      watchBucket,
    });
  }
  return out;
}
