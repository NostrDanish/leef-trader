# AI / Learning / Sizing Audit

Evidence-backed audit of the LEEF Trader engine. Every claim cites a file,
symbol, and where practical a line, plus a deterministic test. Tests cited as
` sizing-audit.test.ts::‹name›` live in `src/lib/leef/sizing-audit.test.ts`
and run under `npm test` (vitest). Nothing in this document is a claim made
without a code path behind it; where the machinery does not exist, the status
says so.

- **Baseline commit:** `2b9b10b` (main) — this audit lands in the commit that
  adds it.
- **Environment note:** the authoring environment builds with esbuild
  (production build green) but has no Node runtime, so `vitest` could not be
  executed *here*. All audit tests are written against hand-verified constant-
  product arithmetic (worked numbers in the test comments). Statuses in §15
  say `WRITTEN` where local execution was impossible and `PASS` only where a
  previously green suite covers it. Run `npm test` for the authoritative pass.

---

## 1. Baseline

**Files inspected (engine core):**

| Area | File | Key symbols |
|---|---|---|
| Sizing / net edge | `src/lib/leef/net-edge.ts` | `optimizeEntrySize` (:134), `evaluateEntry` (:48), `scoreOpportunity` (:219), `SIZE_LADDER` (:121) |
| Cost model | `src/lib/leef/cost-model.ts` | `estimateRoundTripCosts` (:137), `executionCostPct` (:92), `DEFAULT_COSTS` (:55), `realizedVolPerSec` (:108) |
| Routing | `src/lib/leef/route-optimizer.ts` | `rankExecutionRoutesOnGraph` (:555), `searchPaths` (:338), `quoteEdge` (:75), `splitTwoBooks` (:447), `preferLeefNearTies`, `routeSignature` |
| AMM math | `src/lib/leef/amm.ts` | `quoteConstantProduct` (:20) |
| Exact gate | `src/lib/leef/exact-gate.ts` | `exactEntryVerdict` (:60), `exactSwapVerdict` (:93) |
| Venue verification | `src/lib/leef/quote-verify.ts` | `verifyExecutableRoute` (:127), `combineGuaranteedOut` (:48) |
| Opportunity ranking | `src/lib/leef/opportunity.ts` | `selectBestOpportunity` (:319), `executionProbability` (:83), `inventoryFactor` (:108), `calibrationHaircut` (:133) |
| Bot decisions | `src/lib/leef/bot-engine.ts` | `evaluateBot`, `findBestArb` (:584), `gateFromRisk` (:612) |
| Growth | `src/lib/leef/growth-engine.ts` | `planGrowthAction`, `verifyGrowthExact` (:632), `policyOf` (:135), `normalizeTargets` (:169) |
| Execution loop | `src/components/terminal/use-bot-loop.ts` | gate blocks with candidate fallback (`MAX_GATE_ATTEMPTS` = 3), `gateQuote` → `preQuoted` handoff |
| Manual swaps | `src/lib/wallet/trade.ts` | `executeSwap` (routeSig pin, maxHops, cycle firewall), `MAX_SWAP_IMPACT_PCT` (:30), `MAX_MANUAL_SWAP_ACTIONS` |
| Signing | `src/lib/wallet/sign.ts` | `buildTransfers` (:58), `preQuoted` (:69), `signAndPushSwap`, `signAndPushArb`, `signAndPushBatch` |
| Policy firewall | `src/lib/wallet/policy.ts` | `assertActionPolicy`, `arbFloorViolation` |
| Failure taxonomy | `src/lib/wallet/trade-error.ts` | `classifyTradeError` (:84), `isEconomicFailureCode` (:48) |
| Evidence | `src/lib/leef/journal.ts` | `journal`, `aggregateEntries`, `toNdjson`, `MAX_ENTRIES` = 60k |
| AI client | `src/lib/leef/ai-analyst.ts` | `aiTask`, `aiHealth`, `aiBudget`, `extractGrowthTargets` |
| AI UI | `src/components/terminal/ai-desk.tsx`, `bot-desk.tsx` (`TreasureCard.askAiForMix`) | advisory only |
| Rebalancer | `src/lib/leef/rebalance.ts`, `src/components/terminal/use-portfolio-loop.ts` | `planRebalance`, `quoteLegs`, `chunkSweepLegs`, `quoteOracleDeviationPct` |

**Previous sizing behavior / midpoint bias:** No midpoint or fixed-clip bias
was found in the decision path. `optimizeEntrySize` evaluates the 7-point
`SIZE_LADDER` over `[minIn, maxIn]` and then ternary-refines around the
winner (`net-edge.ts:165–191`); selection is `argmax(netProfitUsd)` among
passing candidates (`:162`). The 50% ladder point is *evaluated*, never
preferred by construction. **Status: NOT FOUND (no bias exists).**

**Current AI integration points:** `ai-desk.tsx` (market/strategy/evidence
tasks), `bot-desk.tsx` TreasureCard mix suggester (human applies). No AI code
is imported by any trade-path module — proven by `ai-boundary.test.ts`.

**Current evidence capabilities:** append-only IndexedDB journal of
decisions (incl. HOLD reasons), gate verdicts (pass/fail, expected vs
guaranteed out, attempt #), executions (status, expected vs actual out, P&L,
latency), per-trade calibration pairs; Evidence desk aggregates; NDJSON
export. See `docs/EVIDENCE.md`.

---

## 2. Sizing audit

**Code path (entry sizing), per scan, per decision:**

```
use-bot-loop.ts: refreshExecutionState (fresh critical pools)
  → optimizeEntrySize({ snap: book, minIn, maxIn, expectedGrossPct, minNetEdgePct, volPerSec })
      net-edge.ts:154 consider(x):                       // candidate generation
        → bestExecutionRoute(book.pools, book.aux, x)    // route RE-SEARCHED per size
          route-optimizer.ts:75 quoteEdge:               // per-leg CP quote; rejects when
            reserveIn < 1.5×amountIn  (MIN_RESERVE_MULT) //   liquidity floor
            priceImpact ≥ 0.35        (MAX_IMPACT)       //   impact ceiling
        → executionCostPct (fee+impact, single-counted)  // cost-model.ts:92
        → estimateRoundTripCosts (exit modeled too)      // cost-model.ts:137
        → pass ⇔ netEdgePct ≥ minNetEdgePct ∧ netProfitUsd ≥ 0  // net-edge.ts:96
  → argmax netProfitUsd over passing candidates + ternary refine (:174–191)
  → exact-quote gate on the venue's executable output     // use-bot-loop.ts
  → portfolio governor (may resize down → gate re-runs)
```

- **Minimum executable size:** `bounds.minIn` from `risk.minTradeUsd` at the
  live mark (`risk-usd.ts:usdToTokenBounds`); plus venue dust: outputs that
  round to zero are refused at sign (`sign.ts:104–109`).
- **Maximum executable size:** `bounds.maxIn` = min(position cap headroom,
  wallet minus operational reserve); then per-size physics (reserve floor,
  impact ceiling) shrink it further inside the scan.
- **Constraints honored per candidate:** liquidity (reserve floor), pool
  bottleneck (per-leg quote chaining), fees (inside the quote), price impact
  (ceiling + costed), route complexity (hop/exec-probability penalty in
  scoring, `opportunity.ts:83`), inventory (governor + `inventoryFactor`),
  opportunity cost (volatility decay term, `cost-model.ts:150`), regime
  (danger score sizes entries down, `regime.ts:dangerScore`), exact-quote
  validation (gate).
- **Execution probability:** modeled 0–1 from hops/actions/impact/depth
  (`opportunity.ts:83–96`), gate minimum 0.35 (`bot-engine.ts:616`).
- **Learned pool/route size profile:** **NOT FOUND → DEFERRED.** The journal
  now records the substrate (per-execution expected vs actual out), but no
  learned per-pool size curve is applied yet.

**"Can the engine independently choose $0.20, $0.50, $0.60, $1.13, $3.00,
$5.00, $9.80, or HOLD depending on current economics?"**

Yes — the scan is continuous within the band: ladder probes + ternary
refinement evaluate arbitrary sizes and select by net profit; HOLD is the
null result. Proven by `sizing-audit.test.ts::§3` (optimum ≈169 WAX ≈ $3.38
on a $0.10–$10 band — neither midpoint nor max), `::§4` (chooses the
$0.20-scale floor where $5 loses), and `::§3 micro band / HOLD` (bad thesis →
null → HOLD).

---

## 3. Size-optimization evidence

**Objective function actually used** (`net-edge.ts:90–96` +
`cost-model.ts:137–162`):

```
netProfitUsd(x) = notional(x)·expectedGrossPct/100
                − notional(x)·( execInPct(x)        // entry fee+impact, measured from the quote
                              + execOutPct(x)        // exit fee+impact, modeled at exit size
                              + slippageBufferPct    // expected reserve-drift allowance (0.05%)
                              + decayPct )/100       // vol/sec × latency × decaySigma
                − (resourceUsd + failureUsd)         // WAX CPU/NET + revert risk (≈0 when staked)
pass(x) ⇔ netEdgePct(x) ≥ minNetEdgePct ∧ netProfitUsd(x) ≥ 0
winner  = argmax_x netProfitUsd(x)    over ladder probes + 8 ternary iterations
```

`execIn/OutPct` grow with size (impact), gross scales linearly → net profit
is concave → interior maximum, usually *smaller* than the configured max.

**Non-midpoint proof:** `sizing-audit.test.ts::§3 size optimization —
non-midpoint optimum`. Fixture: 50,000 WAX × 500M LEEF, band 5–500 WAX
($0.10–$10), thesis +2%. The $5.05 midpoint probe and the $10 max are both
evaluated and both lose to the interior optimum (≈$3.38). `tried[]` exposes
every candidate's economics for inspection.

---

## 4. Micro-pool audit

`sizing-audit.test.ts::§4 micro-pool — $0.20 wins where $5 loses`.

Fixture: 2,000 WAX × 20M LEEF (0.3% fee), thesis +2%.

| Size | Impact | Round-trip cost | Net edge | Verdict |
|---|---|---|---|---|
| 10 WAX ($0.20) | ≈0.50% | ≈1.64% | +0.36% | **PASS — chosen** |
| 250 WAX ($5) | ≈11.1% | ≈23% | −21% | quoted but `pass=false`, netProfitUsd < 0 |

The engine is not hard-coded to reject small trades or small pools; the
physics of the book decides. Exact reason: `optimizeEntrySize` argmax over
`netProfitUsd`, with `evaluateEntry` returning `pass=false` when
`netEdgePct < minNetEdgePct` (`net-edge.ts:96`).

---

## 5. Multi-hop / bottleneck audit

`sizing-audit.test.ts::§5 multi-hop bottleneck`.

Route: WAX → AAA → BBB → WAXUSDC (pools #201/#202/#203, 0.3% per hop).
Outer books 10,000 deep; middle book 400/400.

- **Every pool in the route:** #201 (10,000), #202 (400 ← bottleneck),
  #203 (10,000).
- **Bottleneck mechanism:** `quoteEdge` rejects a leg when
  `reserveIn < 1.5 × amountIn` (`route-optimizer.ts:76`) or
  `priceImpact ≥ 0.35` (`:78`). Hop inputs chain — leg N spends leg N−1's
  output (`searchPaths:421–432`), so the thin middle book's physics caps the
  whole route.
- **Maximum safe size:** arriving-AAA ≤ 400/1.5 = 266.67 ⇒ ≈268 WAX in.
  At 450 WAX the route is **UNQUOTABLE** (`evaluateEntry → null`), not merely
  worse — proven by the test. Control with a deep middle book: the same 450
  WAX is quotable and fails only on economics.
- **Optimal size on the route:** the optimizer never evaluates a candidate
  above the bottleneck cap (`tried.every(≤ 268.5)` asserted) and lands at the
  small-size floor.
- **Execution probability:** 3 hops → `hopPenalty = 1 − 0.12·2 = 0.76`
  (`opportunity.ts:90`); impact/depth factors multiply in.

**Claim proven:** the route is never sized from the strongest pool — the
per-leg quote chain makes the weakest leg binding.

---

## 6. Pool-fee audit

| Venue | Fee source | Fee model | Exact? | Where it enters | In route score? | In exact verify? | Double-count guard |
|---|---|---|---|---|---|---|---|
| Alcor | pool `fee` field (API + on-chain) | deducted from input inside `quoteConstantProduct` (`amm.ts:42–46`) | **Exact** at discovery; **venue-exact** via router at the gate | inside `route.amountOut` → `executionCostPct` (`cost-model.ts:92`) | yes (amountOut drives ranking) | yes — gate re-quotes the venue router | the cost model measures spot→fill gap of the quoted output; fee is never re-added (comment `cost-model.ts:10–14`) |
| Defibox | on-chain pair row `fee` | same CP formula after fresh row read | Fee exact; **output approximate** (CP estimate, `fresh_model`) | same | same | yes — fresh row + drift guard (8%, `quote-verify.ts:250–257`) | same single-count |
| TacoSwap | on-chain pair row `fee` | same | same as Defibox | same | same | same | same |

**Proof of single-counting:** `sizing-audit.test.ts::§6` — 100 WAX into a
10,000/10,000 0.3%-fee book quotes 98.7155 LEEF; `executionCostPct` =
1.2845% (= 0.3% fee + 0.985% curve impact, once). A simulated double-count
(0.3% re-subtracted) yields 1.5806% — asserted strictly greater, and the
engine never produces it.

**Remaining approximation (honest):** Defibox/TacoSwap outputs are
`fresh_model` — fresh reserves + their CP formula; reserve drift between read
and execution is unpriced (min-out memo is the hard guard). Alcor CLMM
discovery quotes are CP estimates on published reserves — the exact gate's
router re-quote is the truth; the journal's gate entries now measure how
often they disagree.

---

## 7. Slippage audit

**A. Expected cost (economics):** `slippageBufferPct` in `CostConfig`
(default 0.05%, `cost-model.ts:38,58`) — an allowance charged to every
candidate, independent of the route quote.

**B. Protection (safety):** `risk.slippage` / desk slippage → min-out in the
venue memo (`sign.ts`, `quote-verify.ts:162,259`) — the chain-enforced worst
case.

**Proof they are distinct variables:** `sizing-audit.test.ts::§7` — doubling
`slippageBufferPct` changes `costs.slippagePct` only; `execInPct`/`execOutPct`
(the measured quote gap) are bit-identical. The min-out path never reads the
cost model.

**Learned historical slippage → future sizing:** **PARTIAL.**
`calibrationHaircut` (`opportunity.ts:133`) adjusts *predicted edge* from
persisted predicted-vs-realized history (store `stats.byStrategy`, survives
reload). The journal (P1) now records `expectedOut` vs `actualOut` per
execution — the substrate for a true learned slippage model — but no such
model is applied to sizing yet. **DEFERRED** (data collection first; that was
the agreed sequence).

**Hard upper bound vs AI:** the AI has no write path to `risk.slippage` or
the cost config at all (import-graph proof, §8/§14). The bound is structural,
not a check.

---

## 8. AI learning audit

**What the AI can do today (the complete list):**

1. Answer `market_analysis` / `strategy_analysis` / `evidence_review` with
   compact context (`ai-desk.tsx`).
2. Propose a growth-target mix (1–5 tokens with weights) that a **human**
   applies with one click (`bot-desk.tsx::TreasureCard.askAiForMix`,
   extraction in `ai-analyst.ts::extractGrowthTargets` — candidate allowlist,
   weight renormalization, 5-cap).

**What it cannot do:** sign, broadcast, bypass policy/risk/gates, change hard
limits, mutate code, or reach the trade path in any way — there is no import
edge from the trade path to the AI client (`ai-boundary.test.ts`), and the
gateway forces `"trade_authorization": false` server-side.

**Typed learning artifacts** (pool size profiles, route preferences, regime
weights, HOLD thresholds, …): **NOT FOUND — DEFERRED.** No artifact schema,
governor, shadow test, or promotion rule exists yet. When built, each
artifact must carry: schema, source evidence (journal NDJSON), minimum
sample, confidence floor, max delta clamp, expiry, rollback, shadow-then-
promote. The journal is the evidence substrate; §17 tracks this gap.

---

## 9. AI mode audit

| Mode | Exists? | Behavior |
|---|---|---|
| **OFF** | ✅ | `terminal.aiEnabled=false` → zero network calls (no health ping, no tasks); desk shows the off state. Persisted per browser. |
| **SUGGEST** (default) | ✅ | All tasks advisory; the only mutating output (growth mix) requires a human click; the engine trades deterministically regardless. |
| **CONTROLLED_LEARNING** | ❌ DEFERRED | No autonomous or semi-autonomous AI adjustment exists. |

- AI failure never blocks trading: no trade-path module imports the client;
  `aiTask` failures surface only on the desk.
- AI output cannot reach the signer: `ai-boundary.test.ts` + the worker's
  forced `trade_authorization: false`.
- Session scoping: the mix suggestion is just a config edit (persisted like
  any user edit; reverting = edit the targets again).
- Reject/disable: dismiss the suggestion, or flip the AI toggle off.

---

## 10. Learning-evidence audit

Journal (`src/lib/leef/journal.ts`) currently records:

| Requested field | Recorded? | Where |
|---|---|---|
| decision / HOLD decision | ✅ | `decision` entries incl. HOLD + reason (store `pushDecision`) |
| candidate route / pool IDs / venue | ◑ | route ids inside gate/execution reasons + `poolIds` on gate entries; full candidate list not yet journaled |
| input amount / predicted output / guaranteed output / actual output | ✅ | `execution` + `gate` entries |
| expected edge / realized edge | ✅ | `calibration` entries (per trade) + gate `netPct` |
| fees | ◑ | inside quoted outputs (single-counted); not a separate field |
| expected impact / realized slippage | ◑ | derivable from expected vs actual out; no dedicated fields yet |
| quote age | ◑ | gate `verifyMs` (latency); book age not journaled |
| liquidity / volatility / regime | ◑ | leefUsd/waxUsd context scalars; regime/vol not journaled per entry |
| execution probability | ❌ | computed in scoring, not journaled |
| failure class | ✅ | decision `error` entries carry `CODE: message`; gate failures carry reasons |
| latency | ✅ | `latencyMs` on executions/AI calls; `verifyMs` on gates |
| resource cost | ❌ | CPU/NET cost not measured per tx |
| AI recommendation / artifact / model / session IDs | ◑ | `kind:"ai"` entries carry task+latency+digest; no artifact IDs (no artifacts exist) |
| **Counterfactual HOLD outcomes** | ❌ **DEFERRED** | HOLDs are journaled with reasons; what *would* have happened is not tracked. |

Honest summary: the spine (decisions, gates, executions, calibration) is
recorded; the analytical periphery (per-entry regime/vol/exec-probability,
resource cost, counterfactuals) is **PARTIAL/DEFERRED** and should be added
as compact scalars when the learning layer is designed — not before.

---

## 11. Failure-classification audit

Taxonomy (`trade-error.ts:6–31`) covers: QUOTE_TIMEOUT, QUOTE_STALE,
ROUTE_DISAPPEARED, LIQUIDITY_CHANGED, SLIPPAGE_TOO_HIGH, MIN_OUT_FAILED,
INSUFFICIENT_BALANCE, INSUFFICIENT_CPU/NET/RAM, RPC_FAILURE, QUOTE_FAILURE,
API_RATE_LIMIT, SIGNING_FAILURE, TRANSACTION_REJECTED/FAILED/UNKNOWN,
POLICY_BLOCK, POSITION_LIMIT, NET_EDGE_TOO_LOW, PRICE_UNCERTAIN/DEPEGGED,
VENUE_UNAVAILABLE, MODEL_ONLY. (The requested names map 1:1; e.g.
EXPECTED_HOLD = `hold` decisions with reasons, EXECUTION_FAILURE =
TRANSACTION_FAILED.)

**Market vs infrastructure separation:** `isEconomicFailureCode`
(`trade-error.ts:48–58`) — only MIN_OUT_FAILED, SLIPPAGE_TOO_HIGH,
LIQUIDITY_CHANGED, TRANSACTION_FAILED/REJECTED, PRICE_UNCERTAIN/DEPEGGED
teach the danger score. RPC/rate-limit/venue/CPU/policy do not. The danger
input filter consumes it (`use-bot-loop.ts` recentFailures).

**"AI must not learn increase-slippage from an RPC failure":** proven by
`::§11` — including a test feeding the *actual observed* 2026-09-16
`tx_cpu_usage_exceeded` sweep-revert body through `classifyTradeError`
(classifies RPC_FAILURE, not economic).

**Known gap (LOW):** per-tx CPU overruns classify as RPC_FAILURE (transport)
rather than a dedicated TX_CPU_EXCEEDED class; the sweeper's cooldown keys
off the raw message instead. Behavior is safe; the class is imprecise.

---

## 12. Volume-maker audit

Transaction count is **not** the optimization objective anywhere:

- Echoes are found by `findBestArb` maximizing **net WAX profit** per size
  (`bot-engine.ts:596–601`), floored at `−maxEchoLossPct` (bounded loss
  budget; default 1.5%, `bot-engine.ts:245`).
- The exact gate re-runs the echo's floor on the venue quote
  (`exactSwapVerdict` with `minNetPct = −maxEchoLossPct`; use-bot-loop
  arb path).
- On-chain, the sell legs' min-outs must sum to ≥ stake × (1+floor) or
  nothing signs (`policy.ts::arbFloorViolation` + signer re-check).
- Opportunity ordering sorts by expected USD value, volume intent **last**
  (`opportunity.ts:338–343`).
- Hourly cadence caps exist (`maxTradesHour`).

**Tests:** `::§12` — an echo inside the loss budget is found and is a bounded
loss (`waxOut < waxIn`, ≥ −1.5%); with a +0.3% profit floor the same flat
book produces **nothing**. Volume is bought with a budget, never free.

---

## 13. Growth / investment audit

- **LEEF preference never overrides economics:** `preferLeefNearTies`
  re-ranks only within a 0.5% near-tie band of best expected output
  (`route-optimizer.ts`); the exact gate still vetoes anything uneconomic.
  Tests: `route-optimizer.test.ts::LEEF near-tie preference`.
- **Positive expected growth required:** `verifyGrowthExact`
  (`growth-engine.ts:632`) re-runs the growth thesis on the *venue-exact*
  output; value-drop caps per mode (`policyOf:135+`, e.g. balanced
  `acquireDropCapPct 1.2`, `maxImpactPct 3.5`).
- **HOLD allowed:** `planGrowthAction` returns null → HOLD with a why (the
  growth firewall HOLDs when the book doesn't offer enough expected growth).
- **User limits preserved:** governor + `maxPositionUsd` + reserve apply to
  growth decisions identically; targets cap at 5 (`normalizeTargets:169`).
- **Route-size optimization applies:** growth swaps route through
  `bestExecutionRoute` and the same gate fallback loop.
- **Learned behavior destroying allocations:** impossible today — no learned
  behavior exists (§8).

---

## 14. Security / execution-boundary audit

Actual trace (all file-verified):

```
AI desk / mix suggester (ai-desk.tsx, bot-desk.tsx)
  │   writes: nothing automatic. Human clicks "Use this mix" → growthTargets
  ▼
store config (store/bot.ts)            ← the ONLY AI-adjacent mutation
  ▼
evaluateBot (bot-engine.ts)            strategies propose
  ▼
optimizeEntrySize / findBestArb / planNextAction / planGrowthAction
  ▼
selectBestOpportunity (opportunity.ts) EV ordering, volume last
  ▼
use-bot-loop: refreshExecutionState → exact-quote gate (≤3 candidates,
  exactEntryVerdict / exactSwapVerdict / verifyGrowthExact)
  ▼
governTrade (portfolio-governor.ts)    resize ⇒ gate quote discarded
  ▼
waxResourceBlock (chain.ts)            CPU/NET/RAM preflight
  ▼
assertActionPolicy (policy.ts)         allowlisted contracts/actions/
                                       tokens/receivers; arb floor invariant
  ▼
sign (sign.ts)                         gate-approved preQuoted memos;
                                       imported-key txid known pre-broadcast
  ▼
broadcast → waitForTransaction → reconcile (chain truth settles P&L)
  ▼
journal (journal.ts)                   sink only — signs nothing
```

**Rejection boundaries for any AI-originated change:** store edit (human) →
strategy math → cost model → exact venue gate → governor → resource
preflight → policy firewall → signer. AI reaches none of them directly.

**Proof AI cannot reach signing/broadcast:** `ai-boundary.test.ts` —
trade-path modules contain no `ai-analyst`/`aiTask` reference; the AI client
contains no signer/secret/session reference. This is a *failing-build*
guarantee, not a convention.

---

## 15. Test matrix

`PASS` = covered by a suite that was green when last runnable here / runs in
CI. `WRITTEN` = new deterministic test authored this commit, arithmetic
hand-verified, `npm test` required for the authoritative run (no Node runtime
in the authoring environment — see header).

| Test | Expected | Actual | Status |
|---|---|---|---|
| No midpoint sizing | argmax ≠ 252.5 WAX on 5–500 band | ≈169 WAX optimum; midpoint+max both evaluated and worse | WRITTEN (`§3`) |
| Dynamic per-scan sizing | re-scan on refreshed book pre-trade | `use-bot-loop.ts` re-optimizes on `book` before gate | PASS (code path + existing net-edge tests) |
| Micro-pool optimal size | $0.20 chosen, $5 rejected | floor size wins; 250 WAX pass=false | WRITTEN (`§4`) |
| Multi-hop bottleneck | route capped by 400-deep middle book | 450 WAX unquotable; all tried ≤268.5 | WRITTEN (`§5`) |
| Pool-specific fees single-counted | cost 1.2845%, not 1.58% | single-count proven | WRITTEN (`§6`) |
| Slippage separation | allowance ≠ measured impact | execIn/Out bit-identical across configs | WRITTEN (`§7`) |
| AI OFF | zero calls | `aiEnabled` gates health+tasks | PASS (code review; UI manual) |
| AI SUGGEST | advisory + human-applied mix | desk + TreasureCard flow | PASS (code review; extraction unit tests PASS-WRITTEN in `ai-analyst.test.ts`) |
| Controlled learning | n/a | does not exist | DEFERRED |
| AI cannot bypass limits | no import edge | import-graph test | WRITTEN (`ai-boundary.test.ts`) |
| AI outage | trading unaffected | no trade-path dependency | WRITTEN (same test) |
| RPC failure classification | infra ≠ market danger | real CPU-revert body → RPC_FAILURE, not economic | WRITTEN (`§11`) |
| Exact-quote protection | gate-approved quote is what's signed | `preQuoted` handoff + resize discard | PASS (quote-verify/quote-chain tests) |
| Volume maker economics | bounded loss; null under profit floor | both asserted | WRITTEN (`§12`) |
| HOLD/counterfactual evidence | HOLDs journaled; counterfactuals | reasons ✅ / outcomes ❌ | PARTIAL (journal tests PASS for aggregation) |
| Rollback | learned-artifact rollback | no artifacts exist | DEFERRED |

---

## 16. Before / after behavior

"Before" = the naive behavior the audit was chartered to rule out (fixed or
midpoint clip sizing, same-pair-only routing, unverified cycle quotes).
"After" = the current engine, computed by the real code on deterministic
fixtures (worked math in `sizing-audit.test.ts` comments).

1. **Tiny profitable pool** (2,000 WAX book, +2% thesis)
   Before: fixed $5 clip → −21% net → forced loss or blind fire.
   After: **$0.20** (10 WAX) chosen; $5 quoted but `pass=false`. (`§4`)
2. **Deep pool** (50,000 WAX book, $0.10–$10 band, +2% thesis)
   Before: midpoint $5.05 (or max $10) by habit.
   After: **≈$3.38** — interior argmax; midpoint and max both evaluated, both
   worse. (`§3`)
3. **Multi-hop route** (WAX→AAA→BBB→WAXUSDC, 400-deep middle)
   Before: size from the 10,000-deep outer books → revert/shortfall at the
   middle leg.
   After: route capped at ≈**$5.37 equivalent**; oversized = unquotable, not
   attempted. (`§5`)
4. **Poor opportunity** (+0.5% thesis vs ≈1.3% round-trip costs)
   Before: trade anyway because "signal fired".
   After: `optimizeEntrySize → null` → **HOLD** with a reason. (`§3`)
5. **Non-midpoint winner** — the same deep-book fixture: the winner is
   provably neither the 50% probe nor the band max (`§3`), and a LEEF
   near-tie route is preferred only inside 0.5% (`route-optimizer.test.ts`).
6. **Cycle mirage** (LEEF→WUF→WAX→LEEF claiming +56% on a poisoned book)
   Before: desk blocked same-token swaps outright ("Pick two different
   tokens") while showing the fantasy as "winning book".
   After: cycles allowed, but the manual desk warns on >8% claimed yields and
   `executeSwap` requires the venue-exact quote with `guaranteedOut ≥
   amountIn` before signing — the fantasy is **refused, not signed**
   (`trade.ts` cycle firewall; `sizing-audit.test.ts::cycles`).

---

## 17. Remaining gaps

| Gap | Severity | Why it matters | Recommended next step |
|---|---|---|---|
| CP discovery ≠ CLMM truth for Alcor books | MEDIUM | Local ranking can misrank; the gate protects execution but wastes ticks | Measure via gate journal (`attempt`, pass/fail); build tick-level discovery only if the data justifies it |
| Defibox/Taco outputs are `fresh_model` | MEDIUM | Reserve drift between read and execution unpriced | Keep min-out guard; consider re-read-at-sign |
| Per-tx CPU class imprecise (RPC_FAILURE) | LOW | Danger-safe, but cooldown keys off message text | Add TX_CPU_EXCEEDED to the taxonomy |
| Learned slippage/size profiles | DEFERRED | calibrationHaircut is aggregate; per-pool curves unbuilt | Build artifacts only after enough journal data (shadow → promote) |
| Counterfactual HOLD outcomes | DEFERRED | Can't score avoided trades | Journal compact candidate snapshots at HOLD time (top-3) |
| Self-impact measurement | DEFERRED | Our own fills move thin books; realized vs expected captures it indirectly | Derive from journal execution pairs |
| No CONTROLLED_LEARNING mode | DEFERRED | Autonomous adaptation doesn't exist | Design artifact schema + governor first |
| Browser tab dependency | KNOWN | No 24/7 daemon | Optional worker later; keys stay client-side |
| Full candidate list not journaled | LOW | Only winner + gate attempts recorded | Add top-N compact rows per decision |

---

## 18. Final verdict

1. **Is midpoint sizing still possible in the real decision path?**
   **No.** Selection is `argmax(netProfitUsd)` over ladder + ternary
   (`net-edge.ts:154–191`); the 50% probe is evaluated, never preferred. (`§3`)
2. **Is size recalculated on every scan?** **Yes.** Pre-trade re-optimization
   on the refreshed execution book in `use-bot-loop.ts`; sizes are never
   reused across books.
3. **Can the engine select a micro trade when economically optimal?**
   **Yes.** (`§4`: chooses ~$0.20 where $5 fails.)
4. **Can a multi-hop route be sized by its bottleneck?** **Yes**, via per-leg
   quote chaining + reserve/impact floors; oversized routes become
   unquotable. (`§5`)
5. **Are pool fees modeled without double-counting?** **Yes** for all three
   venues (fee inside the quoted output, measured once). Defibox/Taco outputs
   remain `fresh_model` estimates — labeled, guarded by min-out. (`§6`)
6. **Can historical slippage influence future sizing?** **Partially** —
   `calibrationHaircut` adjusts predicted edge from persisted history; a
   dedicated learned slippage model is DEFERRED pending journal data.
7. **Can AI change behavior without bypassing deterministic safety?**
   **Only** via human-applied growth-target mixes. Every downstream gate is
   unchanged and unaware of the suggestion's origin.
8. **Can AI widen slippage beyond hard limits?** **No.** No write path exists
   (import-graph test; structural, not procedural).
9. **Can AI directly sign or broadcast?** **No.** (`ai-boundary.test.ts`;
   worker forces `trade_authorization: false`.)
10. **Can it learn from failed trades without confusing infrastructure with
    market failures?** **Yes** for the danger input
    (`isEconomicFailureCode`; real CPU-revert body tested). Learning proper
    is DEFERRED.
11. **Can the system learn from HOLD decisions?** **Partially** — HOLDs are
    journaled with reasons; counterfactual outcomes are DEFERRED.
12. **Can learned behavior be rolled back?** **Trivially** — the only
    AI-adjacent change is a user config edit. Artifact rollback machinery is
    DEFERRED with the artifact system itself.
13. **Is volume optimized economically rather than by count?** **Yes.**
    (`§12`: bounded loss budget, EV ordering, null under a profit floor.)
14. **Does growth mode preserve hard user limits?** **Yes** — governor,
    position caps, mode policy caps, exact growth firewall. (`§13`)
15. **Top 3 remaining engineering risks:**
    (a) CLMM-vs-CP discovery mismatch on Alcor (measured now via the gate
    journal; fix only when data justifies);
    (b) `fresh_model` reserve drift on Defibox/Taco between quote and
    execution (min-out is the guard);
    (c) thin-market self-impact — our own flow is a large share of volume, so
    predicted-vs-realized tracking (journal) must stay honest before any
    learning layer is trusted.

---

*Audit method: static trace of the listed modules + deterministic fixture
tests through the real engine math. No claim in this document rests on a
summary of a summary.*
