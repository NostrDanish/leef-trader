# Phase 2 — Learning Engine Audit

Implementation audit of the learning layer added around the existing
deterministic engine. Baseline: `73cf0ab` (cycles + 18-section audit). This
document covers the learning work itself. Companion: [AI_LEARNING_SIZE_AUDIT]
(./AI_LEARNING_SIZE_AUDIT.md) (deterministic core) and [EVIDENCE](./EVIDENCE.md).

**Authoring-environment honesty note:** this sandbox has no Node runtime, so
`vitest` could not be executed here. All new tests are deterministic with
hand-traced expectations (see `src/lib/leef/learning.test.ts` comments).
Statuses below say `WRITTEN` unless the suite previously covered the claim.
The production build via esbuild is the only executed gate here; `npm test`
is required for the authoritative run.

## Architecture

Before:
```
market → strategies → size/route optimization → exact gate → governor →
policy → sign → broadcast → reconcile → journal (passive evidence)
```

After (additions in **bold**):
```
market → strategies → size/route optimization ──▶ exact gate → … → reconcile
              ▲                                        │
              │ ACTIVE governor-promoted artifacts only│
              │ (slippage override, size-ceiling ≤1)   ▼
              │                                   journal ──▶ profiles
   LearningGovernor ◀── artifacts ◀── proposals      (pool×size×route)
   (SUGGEST: human promotes / CONTROLLED: auto)        ▲        │
              ▲                                        │        ▼
              └──── shadow scoring ◀──────────────────────── counterfactuals,
                                                     self-impact, failure classes
```

## Components

| Component | File / symbol | Status |
|---|---|---|
| Enriched journal schema (poolIds, routeSig, sizeUsd, hops, venues, regime, volPct, dangerScore, failureClass, realizedSlipPct via fields, selfImpactPct, cycleId) | `journal.ts::JournalEntry`, `setJournalCycleId`, `onJournalEntry` | IMPLEMENTED |
| Prediction/Outcome separation | gate entries (`expectedOut`, `guaranteedOut`, `netPct`) vs execution entries (`actualOut`, `realizedEdgePct`, `pnlUsd`) — never overwritten | IMPLEMENTED |
| Pool/route profiles (size-bucketed, EWMA-decayed) | `learning.ts::Profile`, `applyEntry`, `rebuildProfiles` | IMPLEMENTED |
| Size-response curve per pool | `learning.ts::SIZE_BUCKET_*`, `bucketMeanEdge`; Evidence desk table | IMPLEMENTED |
| Learned slippage (bounded) | `learning.ts::learnedSlippagePct` (min 8 confirmed, clamp 0.02–0.75%, 3-day half-life, 14-day staleness kill) | IMPLEMENTED |
| Counterfactual HOLD engine | `learning.ts::PendingCounterfactual/labelCounterfactual/counterfactualFromMark/FromNetPct`; `learning-store.ts::registerCounterfactual/evaluateDueCounterfactuals`; wired at exact-gate vetoes (entry/swap/growth) + governor vetoes | IMPLEMENTED (mark/requote models, labeled model-based) |
| Failure-class-aware learning | `learning.ts::applyEntry` — infra failures never touch slip/edge stats (uses `isEconomicFailureCode`) | IMPLEMENTED |
| Self-impact measurement | `learning-store.ts::registerSelfImpact/measureDueSelfImpact`; loop registers on confirmed live fills; journaled as follow-up observations | IMPLEMENTED (upper-bound, includes drift — labeled) |
| LearningArtifact (typed schema) | `learning.ts::LearningArtifact` — POOL_SLIPPAGE_PROFILE, POOL_SIZE_MULTIPLIER only | IMPLEMENTED (two types) |
| LearningGovernor | `learning.ts::governArtifact` — schema/clamps/evidence/confidence/expiry/shadow checks; reject/shadow/promote/rollback/expire | IMPLEMENTED |
| Session scoping + expiry + decay | artifact TTL 7d; EWMA half-life 3d; stale-profile kill 14d; artifacts persisted to localStorage, evidence in IDB | IMPLEMENTED |
| Shadow mode | shadow error sums updated per confirmed fill (`learning-store.ts::onEntry`), journaled per sample | IMPLEMENTED |
| Promotion | SUGGEST: human button (governor still validates). CONTROLLED: auto on govern=promote | IMPLEMENTED |
| Rollback | `rollbackArtifact` (reverts to deterministic default) + auto-rollback on shadow/active regression + human button | IMPLEMENTED |
| AI batch artifact generation | — | DEFERRED (P3 — proposals are deterministic for now; the AI desk's evidence_review receives profiles/artifacts as context) |
| Replay engine | — | DEFERRED (decision replay needs snapshot fixtures; the journal records context, not full books) |
| CONTROLLED_LEARNING with AI-proposed artifacts | — | DEFERRED (P3; the mode switch exists and governs deterministic artifacts today) |

## Data flow (proof of the feedback loop)

1. `use-bot-loop.ts` stamps every cycle with `setJournalCycleId` and enriches
   gate/execution entries with `routeJournalMeta` (poolIds, routeSig, hops,
   venues, sizeUsd) + regime/vol/danger via `makeCycleCtx`.
2. `journal()` fans entries to IndexedDB AND to the learning store's live
   listener (`onJournalEntry`) — learning works even with IDB unavailable.
3. `learning-store.ts::onEntry` folds executions into pool+route profiles
   (buckets, EWMA) and updates shadow error sums for scoped artifacts.
4. `refreshProposals()` (desk open + 10-min cadence from the snapshot driver)
   proposes artifacts from profiles that cross sample floors.
5. The governor gates everything; in CONTROLLED mode qualifying artifacts
   auto-promote, in SUGGEST a human clicks Promote on the Evidence desk.
6. The engine reads ONLY `learnedSlippageOverride()` /
   `learnedSizeCeilingMult()` — active artifacts, clamped, expiring.

## Proofs (test references)

- Pool learning: `learning.test.ts::profiles` (accumulation, infra
  isolation, route profiles, EWMA decay at exactly one half-life).
- Size learning: `::learned size multiplier` (1 without evidence; never >1;
  shrinks only when the candidate's own bucket is destructive; smaller
  candidates untouched).
- Slippage learning: `::learned slippage` (null below floor; clamped;
  stale-killed).
- Counterfactuals: `::counterfactual labeling` (TRUE/FALSE/NEUTRAL bands;
  mark model arithmetic; null when marks invalid — never fabricated).
- Governor: `::learning governor` (schema/clamp/evidence rejections; shadow
  keep; promote only when learned error beats baseline ×0.95; rollback on
  regression; expiry).
- AI boundary: `ai-boundary.test.ts` (unchanged — learning modules import no
  signer; AI client unchanged).
- Deterministic core intact: `sizing-audit.test.ts` (unchanged behavior;
  learning is additive and bounded).

## Failure-class learning

`applyEntry` routes failure classes through `isInfraFailure` =
NOT-economic: RPC/rate-limit/venue/CPU/policy failures increment
`infraFails` only — they can never move a slippage curve or a size profile.
Economic failures (min-out, slippage, liquidity drift, tx failure, price
uncertainty) count as `econFails`. Test: `::profiles::infrastructure
failures never touch market statistics`.

## Counterfactual honesty

Labels judge the THESIS, not the decision's risk correctness. Entry
counterfactuals use the price mark minus the round-trip cost modeled at veto
time (`costsPct = thesis − gate netEdgePct`); swap counterfactuals re-rank
the same pair/size on the current book (local CP, labeled `requote`). Arb
vetoes are deliberately NOT counterfactualed (no honest mark for a spread).

## Test matrix

| Test | Status |
|---|---|
| size buckets boundaries | WRITTEN |
| profile accumulation / infra isolation / route profiles / EWMA decay | WRITTEN |
| learned slippage floor/clamp/staleness | WRITTEN |
| size multiplier healthy/destructive/never-up | WRITTEN |
| counterfactual labels + mark model + null-on-no-data | WRITTEN |
| governor reject/shadow/promote/rollback/expire | WRITTEN |
| artifact proposals (floor/stale/thin) + journal rebuild | WRITTEN |
| AI boundary (import graph) | WRITTEN (from Phase 1) |
| existing engine suites (route-optimizer, net-edge, exact-gate, growth, rebalance, …) | previously green; unchanged behavior |

## Remaining gaps (honest)

1. No AI-generated artifacts yet (P3) — proposals are deterministic
   statistics; the AI desk only RECEIVES profile context.
2. No replay engine — the journal stores decision context, not full books.
3. Self-impact is an upper bound (includes market drift); split legs and
   non-LEEF primary pools aren't measured.
4. Learned size adjustment applies to the buy path ceiling only; sell/swap
   paths read slippage override only via… (not wired — buy path only).
5. Counterfactual horizon is fixed at 5 minutes; no multi-horizon analysis.
6. Profiles rebuild from the full journal on boot — fine to ~60k entries;
   needs incremental checkpointing beyond that.
7. ~~Shadow scoring covers slippage artifacts only~~ — FIXED during the
   audit: size-multiplier artifacts shadow-watch their destructive bucket
   (`watchBucket`) and promote only if fresh confirmed fills keep it
   negative; a recovered bucket voids the proposal (or rolls back an active
   one). Test: `learning.test.ts::learning governor::size artifacts promote
   only when the watched bucket stays destructive…`.
