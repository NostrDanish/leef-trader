/**
 * Learning store — the living state on top of the append-only journal.
 *
 *   journal (IndexedDB, truth) ──rebuild at boot──▶ profiles (derived)
 *   journal() listener ──incremental──▶ profiles + artifacts (live)
 *   artifacts ──persist──▶ localStorage (small JSON; rebuilt if wiped)
 *
 * Modes (terminal store):
 *   SUGGEST (default)      — artifacts proposed + shadowed; a HUMAN promotes.
 *   CONTROLLED_LEARNING    — the deterministic governor may auto-promote when
 *                            its criteria are met. AI is never in this loop.
 *
 * The engine reads adjustments ONLY via activeAdjustment() — i.e. only from
 * ACTIVE artifacts. Raw profiles never touch the trade path directly.
 */
import { usdPriceOf } from "./cost-model";
import {
  applyEntry,
  counterfactualFromMark,
  counterfactualFromNetPct,
  DEFAULT_LEARNING_CONFIG,
  governArtifact,
  poolKeyOf,
  proposeArtifacts,
  rebuildProfiles,
  rollbackArtifact,
  sizeBucketIndex,
  SIZE_BUCKET_LABELS,
  type LearningArtifact,
  type LearningConfig,
  type LearningProfiles,
  type PendingCounterfactual,
  type Profile,
} from "./learning";
import { journal, onJournalEntry, type JournalEntry } from "./journal";
import { rankExecutionRoutes } from "./route-optimizer";
import type { LeefSnapshot } from "./types";

const cfg: LearningConfig = DEFAULT_LEARNING_CONFIG;
const LS_KEY = "leef-learning-v1";

/* ------------------------------------------------------------------ */
/* State                                                                */
/* ------------------------------------------------------------------ */

let profiles: LearningProfiles = {};
let artifacts: Record<string, LearningArtifact> = {};
let booted = false;
let booting: Promise<void> | null = null;
let dirty = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function loadArtifacts(): void {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { artifacts?: LearningArtifact[] };
    if (Array.isArray(parsed.artifacts)) {
      for (const a of parsed.artifacts) {
        if (a && typeof a.id === "string") artifacts[a.id] = a;
      }
    }
  } catch {
    /* corrupted cache — rebuilt from journal evidence */
  }
}

function schedulePersist(): void {
  dirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({ artifacts: Object.values(artifacts) }),
      );
    } catch {
      /* storage full/unavailable — evidence still in the journal */
    }
  }, 5_000);
}

/** Incremental learning from every new journal entry. */
function onEntry(e: JournalEntry): void {
  applyEntry(profiles, e, cfg);
  if (e.kind !== "execution" || !e.poolIds?.length) return;
  // Shadow scoring for slippage artifacts scoped to this pool.
  const key = poolKeyOf(e.venues?.[0] ?? "alcor", e.poolIds[0]!);
  const artifact = artifacts[`POOL_SLIPPAGE_PROFILE:${key}`];
  if (!artifact || (artifact.status !== "shadow" && artifact.status !== "active")) return;
  if (e.status !== "confirmed" || !(e.expectedOut! > 0) || !(e.actualOut! > 0)) return;
  const realizedSlip = (1 - e.actualOut! / e.expectedOut!) * 100;
  const baselineErr = Math.abs(artifact.previousValue - realizedSlip);
  const learnedErr = Math.abs(artifact.value - realizedSlip);
  artifact.shadow.n += 1;
  artifact.shadow.baselineErrSum += baselineErr;
  artifact.shadow.learnedErrSum += learnedErr;
  journal({
    kind: "learning",
    artifactId: artifact.id,
    artifactType: artifact.type,
    artifactStatus: artifact.status,
    reason: `shadow sample: realized slip ${realizedSlip.toFixed(3)}% vs baseline ${artifact.previousValue.toFixed(2)}% / learned ${artifact.value.toFixed(2)}%`,
    samples: artifact.shadow.n,
    poolIds: e.poolIds,
    sizeUsd: e.sizeUsd,
    cycleId: e.cycleId,
  });
  governAndMaybeAct(artifact);
  // Size-multiplier shadow: fresh realized edge in the watched bucket.
  const sizeArtifact = artifacts[`POOL_SIZE_MULTIPLIER:${key}`];
  if (
    sizeArtifact &&
    (sizeArtifact.status === "shadow" || sizeArtifact.status === "active") &&
    sizeArtifact.watchBucket != null &&
    e.status === "confirmed" &&
    e.realEdgePct != null &&
    sizeBucketIndex(e.sizeUsd ?? 0) === sizeArtifact.watchBucket
  ) {
    sizeArtifact.shadow.n += 1;
    sizeArtifact.shadow.baselineErrSum += e.realEdgePct;
    journal({
      kind: "learning",
      artifactId: sizeArtifact.id,
      artifactType: sizeArtifact.type,
      artifactStatus: sizeArtifact.status,
      reason: `shadow size sample: realized edge ${e.realEdgePct.toFixed(2)}% in watched bucket ${SIZE_BUCKET_LABELS[sizeArtifact.watchBucket]}`,
      samples: sizeArtifact.shadow.n,
      poolIds: e.poolIds,
      sizeUsd: e.sizeUsd,
      cycleId: e.cycleId,
    });
    governAndMaybeAct(sizeArtifact);
  }
  schedulePersist();
}

function governAndMaybeAct(a: LearningArtifact): void {
  const mode = learningMode();
  const decision = governArtifact(a, Date.now(), cfg);
  if (decision.action === "expire") {
    a.status = "expired";
    journal({ kind: "learning", artifactId: a.id, artifactType: a.type, artifactStatus: "expired", reason: decision.reason });
    schedulePersist();
    return;
  }
  if (decision.action === "rollback") {
    const prev = a.value;
    Object.assign(a, rollbackArtifact(a));
    journal({
      kind: "learning", artifactId: a.id, artifactType: a.type,
      artifactStatus: "rolled_back", artifactValue: a.value, previousValue: prev,
      reason: decision.reason,
    });
    schedulePersist();
    return;
  }
  if (decision.action === "promote" && mode === "controlled") {
    a.status = "active";
    journal({
      kind: "learning", artifactId: a.id, artifactType: a.type,
      artifactStatus: "active", artifactValue: a.value, samples: a.samples,
      confidence: a.confidence, reason: `auto-promoted (controlled): ${decision.reason}`,
    });
    schedulePersist();
  }
  // In SUGGEST mode promotion is a human action on the Evidence desk.
}

/** (Re)build profiles from the journal once per session. */
export async function bootLearning(allEntries: JournalEntry[]): Promise<void> {
  if (booted) return;
  loadArtifacts();
  profiles = rebuildProfiles(allEntries, cfg);
  booted = true;
  onJournalEntry(onEntry);
}

export function learningBooted(): boolean {
  return booted;
}

/* ------------------------------------------------------------------ */
/* Read API for the engine (ACTIVE artifacts only — governed outputs)    */
/* ------------------------------------------------------------------ */

export function activeArtifact(type: LearningArtifact["type"], scopeKey: string): LearningArtifact | null {
  const a = artifacts[`${type}:${scopeKey}`];
  if (!a || a.status !== "active") return null;
  if (Date.now() >= a.expiresAt) {
    governAndMaybeAct(a);
    return null;
  }
  return a;
}

/**
 * Learned slippage override for the cost model, percent — ONLY from an
 * active, governor-promoted artifact. Null = deterministic default.
 */
export function learnedSlippageOverride(venue: string, poolId: number): number | null {
  const a = activeArtifact("POOL_SLIPPAGE_PROFILE", poolKeyOf(venue, poolId));
  return a ? a.value : null;
}

/**
 * Learned size ceiling multiplier (≤ 1) — ONLY from an active artifact.
 * 1 = no learned constraint. Learning can shrink ceilings, never raise them.
 */
export function learnedSizeCeilingMult(venue: string, poolId: number): number {
  const a = activeArtifact("POOL_SIZE_MULTIPLIER", poolKeyOf(venue, poolId));
  return a ? a.value : 1;
}

/* ------------------------------------------------------------------ */
/* Read API for desks                                                   */
/* ------------------------------------------------------------------ */

export function getProfiles(): LearningProfiles {
  return profiles;
}

export function getArtifacts(): LearningArtifact[] {
  return Object.values(artifacts).sort((a, b) => b.createdAt - a.createdAt);
}

/** Profile view incl. a fresh proposal preview (what WOULD be proposed). */
export function profileView(key: string): { profile: Profile; proposals: LearningArtifact[] } | null {
  const p = profiles[key];
  if (!p) return null;
  return {
    profile: p,
    proposals: proposeArtifacts(p, Date.now(), cfg, { slippagePct: 0.05 }),
  };
}

/** Human promotion (SUGGEST mode) — governor still validates first. */
export function promoteArtifact(id: string): { ok: boolean; reason: string } {
  const a = artifacts[id];
  if (!a) return { ok: false, reason: "unknown artifact" };
  const decision = governArtifact(a, Date.now(), cfg);
  if (decision.action !== "promote") return { ok: false, reason: decision.reason };
  a.status = "active";
  journal({
    kind: "learning", artifactId: a.id, artifactType: a.type, artifactStatus: "active",
    artifactValue: a.value, samples: a.samples, confidence: a.confidence,
    reason: `human-promoted: ${decision.reason}`,
  });
  schedulePersist();
  return { ok: true, reason: decision.reason };
}

/** Human rollback — always allowed, always immediate. */
export function rollbackArtifactById(id: string): void {
  const a = artifacts[id];
  if (!a) return;
  Object.assign(a, rollbackArtifact(a));
  journal({
    kind: "learning", artifactId: a.id, artifactType: a.type,
    artifactStatus: "rolled_back", artifactValue: a.value,
    reason: "human rollback",
  });
  schedulePersist();
}

/**
 * (Re)generate artifact proposals from current profiles. Proposals enter as
 * SHADOW. Called on a slow cadence (desk open, and every ~10 min from the
 * market loop) — never inside the trade path.
 */
export function refreshProposals(now = Date.now()): number {
  let created = 0;
  for (const p of Object.values(profiles)) {
    for (const proposal of proposeArtifacts(p, now, cfg, { slippagePct: 0.05 })) {
      const existing = artifacts[proposal.id];
      if (existing && (existing.status === "shadow" || existing.status === "active")) {
        // Refresh evidence counters; keep status/shadow history.
        existing.samples = proposal.samples;
        existing.confidence = proposal.confidence;
        existing.value = proposal.value;
        existing.expiresAt = proposal.expiresAt;
        continue;
      }
      artifacts[proposal.id] = proposal;
      created += 1;
      journal({
        kind: "learning", artifactId: proposal.id, artifactType: proposal.type,
        artifactStatus: "shadow", artifactValue: proposal.value,
        previousValue: proposal.previousValue, samples: proposal.samples,
        confidence: proposal.confidence,
        reason: `proposed from ${proposal.samples} samples on ${p.label}`,
      });
    }
  }
  if (created > 0) schedulePersist();
  return created;
}

/* ------------------------------------------------------------------ */
/* Counterfactual HOLD engine                                           */
/* ------------------------------------------------------------------ */

const pendingCf = new Map<string, PendingCounterfactual>();

/** How long after a HOLD we judge the skipped opportunity. */
export const CF_HORIZON_MS = 5 * 60_000;
/** Second read: the 30-minute trend view of the same veto. */
export const CF_HORIZON_LONG_MS = 30 * 60_000;
const MAX_PENDING_CF = 60;

export function registerCounterfactual(cf: Omit<PendingCounterfactual, "id" | "registeredAt">): void {
  if (pendingCf.size >= MAX_PENDING_CF) {
    const oldest = [...pendingCf.values()].sort((a, b) => a.registeredAt - b.registeredAt)[0];
    if (oldest) pendingCf.delete(oldest.id);
  }
  const id = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  pendingCf.set(id, { ...cf, id, registeredAt: Date.now() });
}

export function pendingCounterfactualCount(): number {
  return pendingCf.size;
}

/**
 * Judge due counterfactuals against the CURRENT book. Mark model for
 * directional theses (entry), local re-quote for swap/cycle paths — labeled
 * accordingly; never fabricated, never a venue claim.
 */
export function evaluateDueCounterfactuals(snap: LeefSnapshot, now = Date.now()): number {
  if (!pendingCf.size) return 0;
  let judged = 0;
  for (const [id, cf] of pendingCf) {
    if (now - cf.registeredAt < cf.horizonMs) continue;
    pendingCf.delete(id);
    let result: { cfPct: number; label: "TRUE_HOLD" | "FALSE_HOLD" | "NEUTRAL_HOLD" } | null = null;
    let model: "mark" | "requote" | "tape" = "mark";
    if (cf.cfKind === "swap") {
      // Swap/cycle: does the same pair/size still clear the net floor?
      const route = rankExecutionRoutes(snap.pools, snap.aux, cf.amountIn, cf.tokenIn, cf.tokenOut)[0];
      if (route) {
        const pxIn = usdPriceOf(cf.tokenIn, snap);
        const pxOut = usdPriceOf(cf.tokenOut, snap);
        if (pxIn > 0 && pxOut > 0) {
          const netPct = ((route.amountOut * pxOut - cf.amountIn * pxIn) / (cf.amountIn * pxIn)) * 100;
          result = counterfactualFromNetPct(netPct);
          model = "requote";
        }
      }
    }
    if (!result && cf.cfKind === "entry") {
      // Strongest evidence first: REAL FILLS printed on the pool inside the
      // veto window (Alcor swaps tape). A thesis judged by the tape is not a
      // model — it's what the market actually paid someone else.
      const tape = cf.poolIds.length > 0
        ? snap.trades.filter(
            (t) =>
              t.poolId === cf.poolIds[0] &&
              t.timestamp >= cf.registeredAt &&
              t.timestamp <= now &&
              t.priceWax > 0,
          )
        : [];
      if (tape.length > 0 && snap.waxUsd > 0) {
        const tapeMarkUsd = tape[0]!.priceWax * snap.waxUsd; // newest real fill
        result = counterfactualFromMark(cf, tapeMarkUsd);
        model = "tape";
      }
      if (!result) {
        const nowMark = usdPriceOf(cf.tokenOut, snap);
        result = counterfactualFromMark(cf, nowMark);
        model = "mark";
      }
    }
    if (!result) continue;
    judged += 1;
    // Dual horizon: after the short-horizon read, re-register the same veto
    // for the long-horizon trend read (labels may legitimately flip — that
    // flip is itself evidence).
    if (cf.horizonMs <= CF_HORIZON_MS) {
      const id2 = `${id}-long`;
      pendingCf.set(id2, { ...cf, id: id2, horizonMs: CF_HORIZON_LONG_MS });
    }
    journal({
      kind: "counterfactual",
      strategy: cf.strategy,
      cfLabel: result.label,
      cfPct: result.cfPct,
      cfModel: model,
      holdReasonClass: cf.holdReasonClass,
      tokenIn: cf.tokenIn,
      tokenOut: cf.tokenOut,
      amountIn: cf.amountIn,
      sizeUsd: cf.sizeUsd,
      poolIds: cf.poolIds,
      venues: cf.venues,
      routeSig: cf.routeSig,
      netPct: cf.predNetPct,
      regime: cf.regime,
      volPct: cf.volPct,
      dangerScore: cf.dangerScore,
      reason: `${result.label}: held ${cf.tokenIn}→${cf.tokenOut} $${cf.sizeUsd.toFixed(2)} (${cf.holdReasonClass}); 5-min counterfactual ${result.cfPct >= 0 ? "+" : ""}${result.cfPct.toFixed(2)}% (${model})`,
      leefUsd: snap.leefUsd,
      waxUsd: snap.waxUsd,
    });
  }
  return judged;
}

/* ------------------------------------------------------------------ */
/* Self-impact tracking                                                 */
/* ------------------------------------------------------------------ */

type PendingImpact = {
  poolId: number;
  /** True when the pool lives in snap.aux (Defibox/Taco/Alcor aux), not snap.pools. */
  aux: boolean;
  preSpotUsd: number;
  /** Aggregate LEEF/USD mark at registration — the drift reference. */
  preMarketUsd: number;
  sizeUsd: number;
  action: string;
  tokenIn: string;
  tokenOut: string;
  routeSig?: string;
  at: number;
};

let pendingImpact: PendingImpact | null = null;

/** Called by the loop right after a confirmed live fill on a LEEF pool. */
export function registerSelfImpact(p: PendingImpact): void {
  pendingImpact = p;
}

/**
 * USD spot of a pool's priced token: LEEF pools via waxPerLeef; aux pools
 * via the WAX side's reserve ratio. 0 when not derivable.
 */
export function poolSpotUsd(
  pools: LeefSnapshot["pools"],
  aux: LeefSnapshot["aux"],
  poolId: number,
  waxUsd: number,
): number {
  if (!(waxUsd > 0)) return 0;
  const main = pools.find((x) => x.id === poolId);
  if (main) {
    const waxPerLeef = main.waxPerLeef ?? (main.leefPerPair > 0 ? 1 / main.leefPerPair : 0);
    return waxPerLeef > 0 ? waxPerLeef * waxUsd : 0;
  }
  const a = aux.find((x) => x.id === poolId);
  if (!a) return 0;
  const waxIsA = a.tokenA.symbol.toUpperCase() === "WAX" && a.tokenA.contract === "eosio.token";
  const waxIsB = a.tokenB.symbol.toUpperCase() === "WAX" && a.tokenB.contract === "eosio.token";
  if (!waxIsA && !waxIsB) return 0;
  const waxQty = waxIsA ? a.tokenA.quantity : a.tokenB.quantity;
  const tokQty = waxIsA ? a.tokenB.quantity : a.tokenA.quantity;
  if (!(waxQty > 0) || !(tokQty > 0)) return 0;
  return (waxQty / tokQty) * waxUsd;
}

/**
 * On the next fresh snapshot, measure the primary pool's spot move around
 * our fill. Upper-bound estimate (includes market drift) — labeled as such.
 */
export function measureDueSelfImpact(snap: LeefSnapshot, now = Date.now()): void {
  const p = pendingImpact;
  if (!p) return;
  if (now - p.at < 20_000) return; // need at least one intervening book
  if (now - p.at > 10 * 60_000) {
    pendingImpact = null;
    return;
  }
  const post = poolSpotUsd(snap.pools, snap.aux, p.poolId, snap.waxUsd);
  if (!(post > 0) || !(p.preSpotUsd > 0)) return;
  pendingImpact = null;
  const rawPct = ((post - p.preSpotUsd) / p.preSpotUsd) * 100;
  // Drift correction (LEEF pools only): subtract the aggregate market move
  // over the same window. Aux pools keep the raw upper bound (labeled).
  const marketPct =
    !p.aux && p.preMarketUsd > 0 && snap.leefUsd > 0
      ? ((snap.leefUsd - p.preMarketUsd) / p.preMarketUsd) * 100
      : null;
  const selfImpactPct = marketPct != null ? rawPct - marketPct : rawPct;
  journal({
    kind: "execution",
    action: p.action as JournalEntry["action"],
    status: "confirmed",
    selfImpactPct,
    poolIds: [p.poolId],
    sizeUsd: p.sizeUsd,
    routeSig: p.routeSig,
    tokenIn: p.tokenIn,
    tokenOut: p.tokenOut,
    reason:
      marketPct != null
        ? `self-impact (drift-corrected): pool #${p.poolId} moved ${rawPct >= 0 ? "+" : ""}${rawPct.toFixed(3)}%, market ${marketPct >= 0 ? "+" : ""}${marketPct.toFixed(3)}% → ours ≈ ${selfImpactPct >= 0 ? "+" : ""}${selfImpactPct.toFixed(3)}% after our ${p.action}`
        : `self-impact (upper bound, incl. drift): ${p.aux ? "aux " : ""}pool #${p.poolId} spot ${selfImpactPct >= 0 ? "+" : ""}${selfImpactPct.toFixed(3)}% after our ${p.action}`,
    leefUsd: snap.leefUsd,
    waxUsd: snap.waxUsd,
  });
}

/**
 * Inject externally-proposed artifacts (AI pattern discovery). The governor
 * pre-validates every proposal — rejections never reach the desk. Accepted
 * proposals enter as SHADOW; promotion follows the same rules as
 * deterministic proposals. Discovery is the AI's role; authority is the
 * governor's.
 */
export function injectArtifacts(list: LearningArtifact[]): { added: number; rejected: number } {
  let added = 0;
  let rejected = 0;
  for (const a of list) {
    const existing = artifacts[a.id];
    if (existing && (existing.status === "shadow" || existing.status === "active")) continue;
    const decision = governArtifact(a, Date.now(), cfg);
    if (decision.action === "reject" || decision.action === "expire") {
      rejected += 1;
      journal({
        kind: "learning",
        artifactId: a.id,
        artifactType: a.type,
        artifactStatus: "rejected",
        reason: `AI proposal rejected by governor: ${decision.reason}`,
      });
      continue;
    }
    artifacts[a.id] = a;
    added += 1;
    journal({
      kind: "learning",
      artifactId: a.id,
      artifactType: a.type,
      artifactStatus: "shadow",
      artifactValue: a.value,
      samples: a.samples,
      confidence: a.confidence,
      reason: "AI-proposed artifact → shadow (governor-validated)",
    });
  }
  if (added > 0) schedulePersist();
  return { added, rejected };
}

/* ------------------------------------------------------------------ */
/* Learning mode (mirrors the terminal store; kept import-light)         */
/* ------------------------------------------------------------------ */

let modeProvider: () => "suggest" | "controlled" = () => "suggest";
export function setLearningModeProvider(fn: () => "suggest" | "controlled"): void {
  modeProvider = fn;
}
function learningMode(): "suggest" | "controlled" {
  return modeProvider();
}
