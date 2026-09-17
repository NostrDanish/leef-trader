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
| AI batch artifact generation | `learning.ts::extractLearningArtifacts` + `learning-store.ts::injectArtifacts` + `ai-desk.tsx` evidence_review flow | IMPLEMENTED (typed-only, evidence-scoped, governor-pre-validated, shadow-first; the AI discovers, statistics decide) |
| Replay engine | — | DEFERRED (decision replay needs book fixtures; the journal records context, not books — a separate storage design) |
| AI modes OFF / SUGGEST / CONTROLLED | `ai-desk.tsx` 3-state control → `terminal.aiEnabled` × `terminal.learningMode` | IMPLEMENTED (CONTROLLED governs deterministic AND AI-proposed artifacts identically) |
| Learned adjustments beyond buy path | swap/growth decisions get the size ceiling (`use-bot-loop.ts` swap block); exits are never learning-gated by design | IMPLEMENTED (sells untouched deliberately) |
| Multi-horizon counterfactuals | `CF_HORIZON_LONG_MS` (30m) re-registration after the 5m read | IMPLEMENTED |
| Self-impact beyond LEEF pools | `learning-store.ts::poolSpotUsd` (WAX-sided aux pools) | IMPLEMENTED |

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

## Phase 3 addendum — market memory + decision replay

Added after this audit, addressing its gap #1 and the self-impact purity note:

- **Market-memory fixtures** (`journal.ts::MarketFixture`, IDB v2 `fixtures`
  store, cap 2000): route-scoped snapshots captured at gate vetoes and
  executions. Route-scoped by design — the decision path needs the candidate
  routes' pools, not the 11 MB universe.
- **Decision replay** (`replay.ts::replayFixture/replayAll` + Evidence desk
  "Decision replay" card): swap/cycle gate fixtures replay the full gate
  verdict (recorded venue outputs + today's logic); entry/growth fixtures
  replay route ranking only. Verdicts: same / flipped / route_changed /
  not_replayable. Decision-logic regression — NOT a P&L backtest.
- **Regime sub-profiles** (`Profile.byRegime`): pool/route behavior split by
  market regime.
- **Drift-corrected self-impact**: LEEF-pool measurements subtract the
  aggregate market move; aux pools keep the labeled upper bound.
- Tests: `replay.test.ts`, regime isolation in `learning.test.ts`.

Still deferred (unchanged): full-tick historical book database (storage
design mismatch), continuous response-curve fitting (buckets suffice until
they measurably don't), learned size increases (ceilings are shrink-only by
deliberate invariant), 24/7 backend.

## Remaining gaps (honest)

1. ~~No replay engine~~ → decision-logic replay IMPLEMENTED (route-scoped
   fixtures; full-tick historical book DB remains deferred by design).
2. Self-impact: drift-corrected for LEEF pools; aux pools remain upper-bound;
   non-primary legs unmeasured.
3. Counterfactual horizons are 5m + 30m — no intraday trend.
4. Profiles rebuild from the full journal on boot — fine to ~60k entries;
   needs incremental checkpointing beyond that.
5. Learned slippage override feeds the buy path's cost model; the swap gate's
   floor comparison uses exact venue quotes already — learned slippage there
   would be redundant shading, deliberately skipped.
6. Size-multiplier artifacts shadow-watch a single bucket (the first
   destructive one); multi-bucket destructive patterns promote conservatively.
7. Shadow scoring for size artifacts: `learning.test.ts::learning governor::
   size artifacts promote only when the watched bucket stays destructive…`
   — promotes only if fresh confirmed fills keep the bucket negative; a
   recovered bucket voids the proposal (or rolls back an active one).
