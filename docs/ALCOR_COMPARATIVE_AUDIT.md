# LEEF Trader × Alcor — comparative architecture audit

Date: 2026-09-19. Method: read the actual code of this repo, of
`alcorexchange/alcor-v2-sdk` (MIT, default branch `main`), of
`alcorexchange/alcor-ui` (default branch `master`, pushed 2026-09-18 —
including its **server-side swapRouter**), and of the publicly reachable
WAX Terminal (`flopsterino.github.io/waxterminal`, client bundle only —
its source repo is not public, so everything about it below is derived
from the shipped JavaScript, which is quoted verbatim where relied upon).
On-chain facts were verified live against `wax.greymass.com` and
`wax.eosusa.io` (Hyperion) during the audit.

This is an **optimization and integration audit**, not a rewrite plan.
Every recommendation is classified KEEP / PATCH / EXTEND / OPTIMIZE /
REFACTOR / REPLACE, and nothing is marked REPLACE without a demonstrated
reason.

---

## 1. Current architecture (from the code, not the README)

```
UI (src/components/terminal/*)
   │  subscribes useMarketEngine; owns no loops
   ▼
MarketEngine (src/lib/market/market-engine.ts) — module singleton
   ├─ heartbeat 1.5 s: headInfo() via rpcPool; drift/suspension detection
   ├─ marketCycle every syncSec (default 30 s): getLeefSnapshot()
   │     └─ snapshot.ts: Alcor REST /swap/pools (full list ~11 MB, 10 min
   │        rediscovery) → hot pool refresh by id (HOT_LEEF=8, HOT_AUX=6)
   │        → attachUsdPrices → LeefSnapshot; cold path: tape (top-4 pools
   │        ×40 swaps), Defibox/Taco discovery, remaining pools
   ├─ onchainSpot every 3rd heartbeat (~4.5 s): fetchOnchainPools(hotIds)
   │     reads swap.alcor `pools` table rows directly (alcor-onchain.ts),
   │     patches sqrtPriceX64 / liquidity / quantities, reprices USD,
   │     bumps routeCache pool versions, re-runs botOnSnapshot
   └─ on wake: routeCache.invalidateAll + resync
        │
        ▼
evaluateBot (src/lib/leef/bot-engine.ts, pure)
   gates (live book, priced oracle, freshness, goals, cooldown, hourly cap)
   → regime (classifyRegime: own price-print series + cross-pool dislocation)
   → dangerScore (shared defensive number; veto ≥ 80, size-down below)
   → strategies produce Decision (buy/sell/arb/swap/hold/stop)
        │
        ▼
runBotOnce (src/components/terminal/use-bot-loop.ts)
   refreshExecutionState (execution-state.ts: re-read ONLY route-critical
   swap.alcor rows if spot older than 8 s)
   → optimizeEntrySize (net-edge.ts: size ladder + ternary refine;
     each size → bestExecutionRoute → estimateRoundTripCosts)
   → exact-quote gate, up to MAX_GATE_ATTEMPTS=3 ranked alternates:
     verifyExecutableRoute (quote-verify.ts)
       all-Alcor non-cycle → ONE swapRouter/getRoute call (venue CLMM)
       else → per-leg: Alcor leg = getRoute maxHops:1;
              Defibox/Taco leg = fresh pair row + CP + min-out memo
     → exactEntryVerdict / exactSwapVerdict (exact-gate.ts)
   → signAndPushSwap (wallet/sign.ts)
       preQuoted gate quote's memos signed verbatim (no second quote race)
       policy.ts firewall → session key (in-memory) or WCW/Anchor
       txid = sha256(packed_trx) known BEFORE broadcast; one submission;
       timeout → markUnknown(txid) + reconcileTransfersLater, never resubmit
   → reconcile.ts: chain transfers are the recorded fill
   → journal.ts (IndexedDB NDJSON): decisions, gate verdicts with
     modelOut + expectedOut (the model↔venue drift metric), executions,
     predicted-vs-realized edge per strategy
```

Route discovery (route-optimizer.ts): directed pool graph (LeefPool +
AuxPool incl. Defibox/Taco), best-first search with a hand-rolled binary
heap, max 10 hops, 8 000-expansion cap, conservative Pareto dominance
(amount ≥, hops ≤, used-pool subset), branching = top-8 quotes ∪ top-4
deepest books (∪ all when ≤16 exits), 2-book golden-section split +
optional 3rd-book residual, split must beat best single by ≥ 0.3 %.
Edge quote = **constant-product on the pool's raw token balances**
(`quoteConstantProduct`, amm.ts).

## 2. Trade lifecycle trace (buy, live)

1. `botOnSnapshot(snap)` (engine-driven) → `runBotOnce` single-flight.
2. `evaluateBot` returns `buy` with a candidate route from CP math.
3. `refreshExecutionState` re-reads the route's pools from chain if the
   spot is >8 s old (route-critical ids + top WAX/stable aux + main
   LEEF/WAX pool).
4. `optimizeEntrySize` rescans size on this book (CP economics).
5. Gate loop: `verifyExecutableRoute` fetches the Alcor router quote for
   the exact size (1.2 s client quote cache, 5 s server-side trade cache —
   see §3), `exactEntryVerdict` re-runs the thesis on the **venue's**
   number with the full cost model incl. platform fee.
6. `signAndPushSwap` signs the gate-approved memos (`preQuoted`), policy
   firewall checks contract/action/token/receiver allowlists, txid known
   pre-broadcast, one submission.
7. `reconcileTransfersLater` reads actual transfers (RPC + Hyperion);
   UNKNOWN stays locked; journal records expected vs actual out.

Observed defects/weaknesses along this trace (details in §5):

- **D1.** The CP edge quote is anchored at the *reserve ratio*, which for
  concentrated CLMM pools is not the pool's price (measured: pool 217
  reserve ratio 40 542 LEEF/WAX vs tick price 25 858.7 — a 56.8 % level
  error at audit time). Ranking, sizing, arb discovery and paper fills
  consume this number. The venue gate prevents *losses*; it cannot recover
  the *misranking, missizing, phantom/missed arbs, and poisoned paper
  learning*.
- **D2.** `findArb` (bot-engine.ts:540) quotes both legs with raw-reserve
  CP, so cross-pool spread detection inherits D1 fully; arb has no
  alternate-candidate loop — one phantom plan burns one gate cycle.
- **D3.** The venue's router response carries a CLMM-exact `priceImpact`
  string; it is parsed (`AlcorRouteQuote.priceImpact`) and then dropped.
  The journal's drift metric compares model vs venue *outputs* only.
- **D4.** Three overlapping "hot pool" sets exist (market-engine
  `hotPoolIds` 8+3+4; snapshot `loadTrackedHot` 8+6; execution-state
  `criticalIds` route+2+1). Not a bug — duplicated logic, divergent
  freshness.
- **D5.** `snap.trades` (the tape) is display-only: no strategy, regime,
  or danger input consumes it. The engine is blind to *flow* (who is
  hitting the pool right now, in which direction, how big).

No money-loss execution bugs were found in the trace. The failure
handling (single submit, txid-first, UNKNOWN lock, policy firewall,
min-out floors, exit-never-edge-gated) is correct and stronger than the
venue's own UI (§3).

## 3. Alcor lessons (verified against source)

### 3.1 What the venue actually is

`alcor-ui` does **not** route client-side. The swap widget
(`components/amm/SwapWidget.vue`) debounces input (600 ms), calls
`GET /api/v2/swapRouter/getRoute`, and **signs whatever the last quote
returned — there is no re-quote at submit time**. LEEF Trader's
gate→preQuoted→sign pipeline is strictly stronger than the venue's own
frontend. KEEP.

The server (`alcor-ui/server/services/apiV2Service/swapRouter.ts`):

- keeps full SDK `Pool` objects **with tick data** per chain, hydrated
  from Redis and patched by a `swap:pool:instanceUpdated` subscription
  (a server-side chain indexer);
- gets candidate pool-id paths from a **Rust route-finder service**
  (`fetchRustRoutes`) — enumeration only, no quoting;
- filters routes to pools that are active AND have ticks
  (`p.tickDataProvider.ticks.length > 0`);
- quotes each route × split-percent with `Trade.fromRoute` (tick-walking
  CLMM math), split grids: `[5,10,15,25,50,75,100]` when maxHops ≤ 2,
  `[25,50,75,100]` when maxHops > 2; combines via `getBestSwapRoute`
  (BFS over percent buckets, bit-mask pool-disjointness, minSplits 1,
  maxSplits 10, early exit once a shorter split won);
- **caps maxHops at 3 server-side** regardless of the request;
- **caches each trade for 5 s** (`CACHE_TTL = 5000`);
- builds memos in `parseTrade`: `swapexactin#<poolIds>#<receiver>#
  <minReceived as ExtendedAsset>#0`, one per swap leg;
- computes minReceived as `output / (1 + slippage)` (Uniswap-style),
  not `output × (1 − slippage)`.

Consequences for LEEF Trader (facts, not speculation):

- **F1.** A "fresh venue quote" can be up to ~5 s old at the venue's own
  cache layer; LEEF's 1.2 s quote cache does not make it staler. The
  on-chain minOut memo is the only real freshness guarantee — which LEEF
  already enforces. This *validates* the existing design; it also means
  re-quoting "to be safe" inside a 5 s window usually returns the
  identical cached trade — do not add more re-quotes.
- **F2.** Routes longer than 3 hops can never be venue-verified as a
  whole (server cap). LEEF handles this via the leg-by-leg path
  (maxHops:1 per leg) — correct, but those legs then execute on
  whichever pool the router prefers for that pair, not necessarily the
  candidate's pool (economically fine, since the router picks the best;
  but the *evaluated* path and the *executed* path can differ).
- **F3.** LEEF's local fallback minOut (`expectedOut × (1 − s)`) is
  tighter than Alcor's (`out / (1 + s)`); only used when `minReceived`
  is absent. Conservative direction. KEEP, no action.
- **F4.** LEEF's `formatAlcorSlippageParam` float-walk (documented live
  evidence of HTTP 500s) matches the server's
  `new Percent(parseFloat(slippage) * 100, 10000)` landmine. KEEP.

### 3.2 The CLMM math core (alcor-v2-sdk)

`src/entities/pool.ts` `Pool.swap()` is a textbook Uniswap-V3 tick
traversal re-based to **Q64** (the WAX contract's `sqrtPriceX64` format):
`TickMath.getSqrtRatioAtTick` ends with `ratio / Q64`
(tickMath.ts:106-109), `MIN_SQRT_RATIO = 4295048017` is the Q64 variant.
`SwapMath.computeSwapStep` (119 lines), `SqrtPriceMath` (128 lines),
`FullMath` (26 lines), `TickList` (208 lines), `TickMath` (165 lines) —
**~500 lines of pure bigint TypeScript, MIT licensed, zero runtime
dependencies that matter** (tiny-invariant is `if(!x) throw`).

The tick data it needs is on-chain and public — verified during this
audit:

```
POST /v1/chain/get_table_rows
{ code: "swap.alcor", scope: "<poolId>", table: "ticks" }
→ { id, liquidityGross, liquidityNet, feeGrowthOutsideAX64, …, initialized }
```

alcor-ui reads it exactly this way (`store/amm/index.js:195-202`,
`fetchTicksOfPool`: `fetchAllRows(rpc, { code: amm.contract, scope:
poolId, table: 'ticks' })`). Pool 217 (main WAX/LEEF, fee 3000) had 22
initialized ticks at audit time — one `get_table_rows` call returns all
(`more: false`).

### 3.3 The level error, measured

For pool 217 at audit time (API and chain agree):

| | real balances (chain row) | virtual CP-equivalent at tick price |
|---|---|---|
| WAX side | 112 613.008 | 124 858 |
| LEEF side | 4 565 638 459 | 3 228 900 000 |
| implied spot (B/A) | **40 542** | **25 858.7** = `priceA` ✓ |

Virtual reserves from the standard V3 transform: `x_virt = L/√P`,
`y_virt = L·√P`, with `L` = pool `liquidity` (20 077 984 976 034) and
`√P` = `sqrtPriceX64 / 2^64`. Both quantities LEEF **already carries on
every LeefPool** (`pool.liquidity`, `pool.sqrtPriceX64`,
`pool.tickSpacing`).

Constant-product on raw balances is wrong twice for concentrated pools:

1. **Level**: spot anchored at the reserve ratio, not the tick price —
   +56.8 % phantom output on WAX→LEEF buys, −36.2 % on LEEF→WAX sells
   (measured, pool 217, audit time).
2. **Depth**: real balances ≠ virtual reserves, so impact is mis-shaped
   even after re-anchoring — though far less than the level error.

The V3 virtual-reserve transform fixes (1) exactly and (2) for any trade
that does not cross an initialized tick. On pool 217 the nearest
initialized ticks were ~+5.3 % / −14.1 % away from the current tick
(9501); with `risk.maxImpactPct = 3 %` and the router's `MAX_IMPACT =
0.35` backstop, the large majority of admitted trades never cross a
tick — i.e. **virtual-reserve CP is exact for the trades LEEF actually
makes**, and the residual error is bounded by the liquidity change at
the crossed tick (and still gated by the venue quote + minOut).

### 3.4 What NOT to take from Alcor

- **Do not import `@alcorexchange/alcor-swap-sdk` as a dependency.**
  It pulls lodash, @msgpack/msgpack, mnemonist, tiny-invariant; its
  `Pool` constructor throws unless the chain's `sqrtPriceX64` sits inside
  its recomputed tick bounds (a data-shapes coupling LEEF does not need);
  its entities are object-plumbing (`Token`, `CurrencyAmount`, `Price`)
  around ~500 lines of math. Port the math, leave the framework.
- **Do not adopt the WASM/Rust route-finders.** They solve a
  thousand-pool enumeration problem. LEEF's tracked graph is ~tens of
  pools with an 8 000-expansion cap — the existing best-first + Pareto
  search is already more sophisticated than Alcor's plain DFS
  (`computeAllRoutes.ts`). The bottleneck was never enumeration.
- **Do not copy the split-percent bucket BFS** (`getBestSwapRoute`).
  LEEF's golden-section split finds the *optimal* share; Alcor's
  quantized buckets (5/10/15/25/50/75/100) exist because it evaluates
  thousands of route×percent pairs in worker threads. Different scale,
  and LEEF's is more precise at its scale.
- **No websocket/subscription backend.** Alcor's `swap:pool:update`
  socket requires their server. §4 shows how to get the equivalent
  signal serverlessly.

## 4. WAX activity lessons (verified against the shipped client)

The WAX Terminal's bundle states its architecture in its header comment:
*"All data comes from store.js, which reads the chain directly; there is
no server anywhere in this application."* Its activity layer (`store.js`
+ `live.js` in the shipped bundle) uses three mechanisms, all verified:

1. **Swap flow from Hyperion `logswap` actions.**
   `recentSwaps()` queries
   `/v2/history/get_actions?act.account=swap.alcor&act.name=logswap&after=<ts>&limit=1000&sort=desc`,
   paged **over a time window** (because "250 swaps covers about 50
   seconds on WAX — a fixed action count is a useless window"), pages
   fetched in parallel, deduped by **`global_sequence`, not `trx_id`**
   ("314 of 1,000 Alcor logswaps share a transaction because a multi-hop
   route is several real swaps"). Verified live at audit time — the feed
   is up and each action carries:

   ```
   poolId, sender, recipient,
   tokenA: "-12.74126792 WAX",   (signed delta — negative = left pool)
   tokenB: "0.00471439 YNOT",
   sqrtPriceX64, liquidity, tick, reserveA, reserveB,   ← post-swap state
   trx_id, global_sequence, block_num, @timestamp
   ```

   **A `logswap` is a free, contract-signed pool-state checkpoint** —
   post-swap price, in-range liquidity and reserves without a table read.

2. **Per-pool state replay via `/v2/history/get_deltas`** filtered by
   primary key — one query replays one pool row's history (price and
   liquidity events) on any of Alcor/Defibox/Taco. "Retention is the
   history node's, not ours."

3. **Gentle polling discipline** for the live tape (`watchPoolTrades`):
   one pool at a time (the one on screen), 7 s cadence, **none while the
   tab is hidden**, exponential backoff to 60 s on failure, dedupe by
   transaction id. The comment is worth internalizing: the person running
   this page also runs bots against the same host from the same address —
   *be gentle with the venue's API*.

How this maps onto LEEF Trader's existing engine (all EXTEND, nothing
replaced): the engine already owns a 1.5 s heartbeat, a health-scored
**historyPool** of 5 Hyperion endpoints (currently used only for
account-history backfill), a `marketBus`, and a dependency-aware
`routeCache`. A flow layer is one more heartbeat-driven poller feeding
the existing invalidation machinery.

What flow data should and should not do (the audit's own constraint —
market data ≠ signal ≠ risk):

```
logswap stream → per-pool rolling flow state (MARKET DATA)
   ├─ swaps in window, buy/sell imbalance, volume rate, largest swap
   ├─ post-swap checkpoints → patch hot pools between table reads
   └─ "someone sold 3 % of the book 2 s ago" → stale-quote risk evidence
        │
        ▼
regime.ts / dangerScore (RISK CONTEXT) — flow can raise danger,
   shrink size, or raise the freshness bar. It must never CREATE an
   entry. Strategies keep deciding from price/book; flow only vets.
```

## 5. Gap analysis

| # | Gap | Evidence | Consequence today |
|---|---|---|---|
| D1 | CP quote anchored at reserve ratio, not tick price; real balances used as CP depth | pool 217 measured +56.8 %/−36.2 % level error (§3.3); `quoteConstantProduct(amountIn, pair.quantity, leef.quantity, fee)` in route-optimizer.ts:77, bot-engine.ts:555/559 | Routes misranked → gate vetoes burn 4 s attempts; sizes mis-optimized (profit left on table, never lost); **paper fills carry the same error → the learning loop calibrates on phantom fills on the most-traded pool** |
| D2 | Arb discovery on raw-reserve CP | bot-engine.ts:540-601 | Phantom spreads vs true-CP venues (Defibox/Taco) and vs tick price; missed real arbs; one-plan arb = one burned gate cycle each |
| D3 | Venue's exact `priceImpact` dropped | quote-verify.ts / alcor-route.ts parse it; nothing consumes it | The drift metric (journal.ts:304-309) compares outputs only; impact-level drift invisible |
| D4 | Three different "hot pool" sets | market-engine.ts:455, snapshot.ts:175-193, execution-state.ts:26-41 | Divergent freshness between what the spot loop patches, what the snapshot refreshes, and what the gate re-reads |
| D5 | No flow/activity input anywhere in the engine | `snap.trades` consumed only by tape.tsx; regime.ts uses own prints + dislocation only | No buy/sell imbalance, no burst detection, no "pool just got hit" staleness evidence between 4.5 s spot reads |
| D6 | Routes >3 hops can only be leg-verified (venue maxHops cap = 3) | swapRouter.ts:219 vs MAX_ROUTE_HOPS=10 | Correctly handled today (leg path), but the *evaluated* path ≠ *executed* path when the router re-picks a pool for a leg |
| D7 | Quote freshness is wall-clock only; venue adds up to 5 s server cache invisible to the client | swapRouter.ts:18 `CACHE_TTL = 5000`; quote-verify QUOTE_TTL_MS=1200 | Not a defect (minOut guards), but `spotAt`/`fetchedAt` semantics should acknowledge the venue cache when reasoning about quote age |

**Explicitly not gaps:** execution safety (single-submit, txid-first,
UNKNOWN lock, policy firewall) exceeds the venue's own UI; the
dependency-aware route cache is the client-side equivalent of Alcor's
Redis invalidation; the NetEdge/cost-model/opportunity-score spine has
no counterpart in Alcor at all; the provider-pool health scoring is more
sophisticated than anything in alcor-ui.

## 6. KEEP — verified working, do not touch

- `src/lib/wax/provider-pool.ts` — health-scored failover, cooldown/
  restore, block-lag rejection. Beyond venue practice.
- `src/lib/wallet/sign.ts`, `trade-cycle.ts`, `chain.ts`, `policy.ts`,
  `reconcile.ts`, `secret.ts`, `session.ts`, `antelope.ts` — the whole
  signing/execution spine. alcor-ui fire-and-forgets through the wallet;
  this is strictly stronger. (Also KEEP `formatAlcorSlippageParam`.)
- `src/lib/leef/exact-gate.ts`, `quote-verify.ts` (structure) — the
  venue-exact gate is the correct answer to CLMM discovery error; this
  audit's P1 item *reduces how often the gate has to veto*, it does not
  weaken the gate.
- `route-optimizer.ts` search (graph, heap, Pareto, golden split) — the
  defect is the edge *quote function*, not the search.
- `net-edge.ts`, `cost-model.ts`, `opportunity.ts` — the economic core.
- `market-engine.ts` loop discipline (single-flight, suspension resync,
  hidden-tab throttling) — matches the venue client's own "be gentle"
  discipline, with better failure handling.
- `journal.ts` / `learning*.ts` / evidence desk — already measuring the
  exact metric (gateDrift) that decides whether the P2 item is worth
  building. That is the right experiment design; keep it.
- Local CP math **for Defibox/Taco** (`venue-adapters.ts`) — those are
  true constant-product AMMs; CP is exact there (fresh row + min-out).
- `docs/*` claims accuracy — ROUTING.md already calls the search "a
  bounded heuristic"; keep that honesty.

## 7. PATCH — small, targeted, high value

**P-A. Anchor Alcor-pool CP quotes at the tick price with virtual
reserves (the single highest-value change in this audit).**
New helper in `amm.ts` (or a small new `clmm-lite.ts`):

```
virtualReserves(pool): { rx, ry } | null
  L = BigInt(pool.liquidity); √P = BigInt(pool.sqrtPriceX64)
  rx = L·2^64 / √P  (raw A units → human via decimals)
  ry = L·√P / 2^64
  null when L ≤ 0 or √P missing → caller falls back to raw reserves
```

Then `quoteEdge` (route-optimizer.ts:75) and `findArb` (bot-engine.ts)
quote Alcor edges with CP over **virtual** reserves instead of raw
quantities; Defibox/Taco legs unchanged (raw = exact). Level error goes
to ~0 at the margin; in-range depth becomes exact; only tick-crossing
trades retain residual error — and those are venue-gated anyway.
No new data, no new calls: `liquidity` and `sqrtPriceX64` are already on
every `LeefPool` and are already refreshed by the on-chain spot loop.
Expected effect: gateDrift (Evidence desk) collapses toward 0 for Alcor
routes; paper fills become honest; arb stops hallucinating.

**P-B. Thread the router's CLMM-exact `priceImpact` into the journal.**
`verifyExecutableRoute` already holds it (`quote.priceImpact`); add
`venueImpactPct` to the gate journal entry and to the drift aggregation
in `journal.ts`. Sharpens the CP↔CLMM evidence from "outputs differ" to
"impact differs by pool/size" — the exact input needed to judge P2.

**P-C. Unify the three hot-pool sets into one exported helper** (e.g.
`hotPoolIds(snap)` in `execution-state.ts` or a shared module), consumed
by market-engine's spot loop, snapshot's tracked-hot refresh, and the
gate's critical-ids. One definition of "what must be fresh to trade".

**P-D. Prefer whole-route-verifiable candidates in the gate ordering.**
In `gateCandidates` (use-bot-loop.ts:163-190), among near-tie routes,
prefer all-Alcor with legs ≤ 3 (the venue's whole-route exact quote
applies; no leg re-pick divergence). This extends the existing
LEEF-then-verifiability tie-break; economics still rule.

**P-E. Document the venue's 5 s trade cache where quote age is
reasoned about** (`quote-verify.ts` header + NET_EDGE.md): within a 5 s
window a re-quote returns the identical cached trade — the minOut memo,
not the re-quote, is the freshness guarantee. Optionally stop
re-requesting a quote that is known to be server-cached (saves one HTTP
call per trade attempt; the `preQuoted` path already does this on the
main path).

## 8. EXTEND — new capability layered on, existing code intact

**E-1. Swap-flow layer (market data, not signals).** New module
`src/lib/market/swap-flow.ts`:

- Every N heartbeats (start at ~10 s), one Hyperion call via the
  existing `historyPool`:
  `/v2/history/get_actions?act.account=swap.alcor&act.name=logswap&after=<lastSeen−overlap>&limit=100&sort=desc`
  (plus the Defibox `swaplog`/`logswap`-equivalent and Taco's later —
  Alcor first).
- Time-windowed paging, parallel pages, dedupe by `global_sequence`,
  pause when `document.hidden`, exponential backoff — the waxterminal
  discipline, verbatim in spirit.
- Maintains per-pool rolling state: swap count, signed LEEF/WAX flow,
  buy/sell imbalance, volume rate, largest swap, last-swap age.
- **Applies each logswap as a free pool-state checkpoint**: for tracked
  pools, patch `sqrtPriceX64`/`liquidity`/reserves into the snapshot
  between 4.5 s table reads (the contract itself just told us the
  post-swap state), bumping `routeCache` versions through the existing
  `notePools` path. Validated against the next real table read.
- Exposes flow to `dangerScore` (e.g. "a swap moved the book >x % within
  the last quote window" raises danger / tightens freshness) and shows a
  flow panel on the Tape desk. It must never create an entry.

Cost: one extra history call per ~10 s against infrastructure LEEF
already runs. No backend, no sockets, no new trust surface.

**E-2. Pool-state history for the pools desk (optional).** waxterminal's
`venueDeltas` pattern — `/v2/history/get_deltas` filtered by primary key
— gives per-pool price/liquidity event history (liquidity adds/removes,
price path) with one query per pool. Feeds charts/analytics, never the
trade path directly. P3.

**E-3 (conditional). Local CLMM tick-walk quoter.** *Only if the
gateDrift metric after P-A still shows material model↔venue drift on the
sizes LEEF actually trades.* Port the ~500-line Q64 math core from the
MIT SDK (`fullMath`, `sqrtPriceMath`, `tickMath`, `swapMath`, trimmed
`tickList` + a slim `Pool.swap` loop) into `src/lib/wax/alcor-clmm.ts`;
fetch `ticks` per hot pool (scope = poolId — verified working), cache
them, refetch when the pool row's `liquidity` changes or on a slow
(60 s) re-poll. Wire into `quoteEdge` for `venue === "alcor"` when tick
data is present; virtual-CP (P-A) when not. The search, splits, gates,
and signing paths do not change. The venue router remains the execution
truth — this makes *discovery* agree with it beforehand.
Explicitly **not** adopting the SDK package, its WASM route-finder, or
its Rust service (§3.4).

## 9. OPTIMIZE

- **O-1.** After P-A, re-measure: if gateDrift ≈ 0, the venue re-quote at
  the gate mostly confirms what the model already knows — the
  `MAX_GATE_ATTEMPTS = 3` loop will veto less and complete faster. No
  code change; expected latency/quote-call savings as a consequence.
- **O-2.** The 11 MB full pool list every 10 min is the heaviest
  recurring pull. Investigate whether Alcor's API supports
  field-filtering/compact payloads; if not, keep — the hot/cold split
  already shields the trade path. P3.
- **O-3.** If E-3 is ever built: tick-walk in a Web Worker only if
  profiling shows the main thread suffering. At 22 ticks and LEEF clip
  sizes, a swap simulation is microseconds; a worker is very likely
  unnecessary. WASM: no (§3.4).

## 10. REFACTOR

None recommended. The only candidate — routing every CP call-site
(quoteEdge, findArb, rebalance-sizing, cost-model) through one
per-pool quote helper — is delivered as part of P-A as a *helper
addition*, not a structural refactor. If a future change adds a fourth
quote call-site, revisit then.

## 11. REPLACE

None. Nothing in the current system was found to be fundamentally
broken, duplicated beyond a PATCH's reach, unsafe, or materially
inferior to its Alcor counterpart. The two components a naive reading
might flag — the local CP model and the hand-rolled route search — are
respectively one PATCH away from exactness-at-LEEF-scale and already
superior to the venue's enumerator.

## 12. Priority order

- **P0 — correctness / money-loss:** none found. The execution layer is
  sound; min-outs and the single-submit discipline hold.
- **P1 — major trading-quality:**
  1. P-A virtual-reserve CP anchor (fixes ranking, sizing, arb,
     paper-fill honesty — the learning loop's input data).
  2. P-B venue `priceImpact` into the journal/drift metric.
  3. P-D gate candidate ordering (whole-route-verifiable first).
  4. E-1 swap-flow layer as danger/freshness input (+ free checkpoints).
- **P2 — meaningful performance/accuracy:**
  5. P-C single hot-pool definition.
  6. P-E venue-cache-aware quote semantics.
  7. E-3 tick-walk quoter — **gated on the P-B evidence** (gateDrift).
- **P3 — useful enhancements:** E-2 pool-state replay charts; O-2
  payload size; flow panel polish.
- **P4 — optional future research:** worker/WASM quoting (only with
  profiling evidence), server-side 24/7 daemon (already documented as
  PLANNED; keys client-side), Alcor socket subscription (requires a
  backend relationship; E-1 already delivers most of the value
  serverlessly).

## 13. Files to change

| File | Function/component | Current | Proposed | Why |
|---|---|---|---|---|
| `src/lib/leef/amm.ts` (or new `clmm-lite.ts`) | new `virtualReserves()` | — | L/√P, L·√P from existing `pool.liquidity` + `pool.sqrtPriceX64` | P-A; exact level + in-range depth for CLMM pools |
| `src/lib/leef/route-optimizer.ts` | `quoteEdge` | CP on raw `reserveIn/reserveOut` | for `venue==="alcor"` use virtual reserves when available, else raw | P-A; fixes the 56.8 % level error at discovery |
| `src/lib/leef/bot-engine.ts` | `findArb` | CP on raw quantities both legs | same helper | P-A; stops phantom/missed arbs |
| `src/lib/leef/rebalance-sizing.ts`, `cost-model.ts` | callers of route amounts | unchanged | unchanged (they consume `route.amountOut`, fixed upstream) | confirms PATCH blast radius |
| `src/lib/leef/quote-verify.ts` | `verifyExecutableRoute` Alcor path | parses quote, drops `priceImpact` | carry `venueImpactPct` through `VerifiedLeg` | P-B |
| `src/lib/leef/journal.ts` | gate entry type + `aggregateEntries` | modelOut vs expectedOut drift | add venue impact; split drift by exactness | P-B; decides E-3 |
| `src/components/terminal/evidence.tsx` | drift line | shows gateDrift | add impact-level drift when present | P-B visibility |
| `src/components/terminal/use-bot-loop.ts` | `gateCandidates` | LEEF → venue-verifiability tie-break | add "all-Alcor ≤3 legs" tier inside near-ties | P-D |
| `src/lib/market/execution-state.ts` | `criticalIds` + new shared `hotPoolIds` | three divergent hot sets | one definition, three consumers | P-C |
| `src/lib/market/market-engine.ts` | heartbeat | spot every 3rd beat | also drive the flow poller (E-1) with hidden-tab pause | E-1 |
| `src/lib/market/swap-flow.ts` | **new** | — | logswap poller + rolling flow state + checkpoint patching | E-1 |
| `src/lib/leef/regime.ts` / danger inputs | `dangerScore` callers | quote age, vol, dislocation, liquidity, failures | optional flow fields, neutral defaults | E-1; risk context only |
| `docs/ROUTING.md`, `docs/NET_EDGE.md` | text | "conservative for CLMM" | correct the claim; document venue 5 s cache + virtual-reserve model | P-E; the docs currently overstate CP safety |
| *(conditional)* `src/lib/wax/alcor-clmm.ts` | **new** | — | Q64 tick-walk port (MIT) + ticks fetch/cache | E-3, only on P-B evidence |

## 14. Files NOT to change

`provider-pool.ts`, `endpoints.ts`, `policy.ts`, `sign.ts`,
`trade-cycle.ts`, `chain.ts`, `antelope.ts`, `reconcile.ts`,
`retry-policy.ts`, `trade-error.ts`, `secret.ts`, `session.ts`,
`route-cache.ts`, `event-bus.ts`, `stables.ts`, `price-oracle.ts`,
`net-edge.ts`, `cost-model.ts` (interface), `exact-gate.ts`
(interface), `opportunity.ts`, `learning*.ts`, `growth-engine.ts`,
`fallback.ts`, `token-registry.ts`, `universe.ts`, `parse.ts` (beyond
nothing), all of `src/components/terminal/*` UI except the two lines
noted, `App.tsx`, `AppRouter.tsx`, all stores. The Nostr shell stays
untouched and off the trade path.

## 15. Architecture after improvements (delta only)

```
                 ┌─────────────── new ───────────────┐
Hyperion pool ──►│ swap-flow.ts: logswap stream       │
 (existing)      │  · per-pool flow state (mkt data)  │
                 │  · post-swap checkpoints ──────────┼──► patch hot pools
                 └──────────────┬─────────────────────┘    between table reads
                                ▼                          (routeCache.notePools)
                        dangerScore / regime (risk context only — never an entry)

route-optimizer / findArb / sizing
        │  quoteEdge:  venue==="alcor" ? CP(virtualReserves)  ← from existing
        │                                 (L, sqrtPriceX64)      pool fields
        │              defibox/taco   ? CP(raw reserves)   ← exact already
        │              (conditional E-3: tick-walk when ticks cached)
        ▼
   …unchanged: NetEdge → gates → venue exact quote → policy → sign-once →
   reconcile → journal (now with venueImpactPct; gateDrift arbitrates E-3)
```

Everything else — the engine loops, the economic core, the execution
spine, the evidence loop — is byte-identical in behavior or untouched.

## 16. Migration plan (each step leaves the app runnable)

1. **Step 1 (P-A + P-B).** Add `virtualReserves` + wire `quoteEdge` and
   `findArb`; add `venueImpactPct` to gate journal + evidence desk. Unit
   tests: pool 217 fixture — virtual-CP marginal quote must equal the
   tick price (25 858.7) and beat raw-CP (40 542) against it; CP venues
   unchanged; fallback when `liquidity`/`sqrtPriceX64` absent.
   **Acceptance is measured, not asserted**: watch Evidence → gateDrift
   over the next sessions; it should collapse toward 0 for Alcor routes.
2. **Step 2 (P-C + P-D + P-E).** Shared hot-pool helper; gate candidate
   ordering; docs corrections (ROUTING.md's "conservative" claim,
   venue 5 s cache note). No behavior risk; keeps `npm test` green.
3. **Step 3 (E-1).** Ship `swap-flow.ts` read-only first (flow panel on
   the Tape desk; checkpoints applied + validated against table reads).
   Only after the checkpoint stream proves consistent in the journal,
   wire flow into `dangerScore` with neutral defaults. Feature-flag via
   the terminal store if a kill-switch is wanted.
4. **Step 4 (E-3, conditional).** Only if post-Step-1 gateDrift remains
   material at traded sizes: port the Q64 tick-walk behind `quoteEdge`,
   ticks cache with refetch-on-liquidity-change, CP-virtual fallback.
   The venue gate and minOut floors stay exactly as they are — this
   changes *discovery*, never the execution contract.

No step requires a rewrite; every step is revertible independently;
steps 1–3 touch no signing code at all.

---

### Appendix — verified external facts relied upon

- `swapRouter.ts` (alcor-ui master, audited 2026-09-19): maxHops capped
  at 3; `CACHE_TTL = 5000`; split grids `[5,10,15,25,50,75,100]` /
  `[25,50,75,100]`; route enumeration delegated to a Rust service; pool
  instances carry tick data; memo format
  `swapexactin#<poolIds>#<receiver>#<minReceived ExtendedAsset>#0`;
  `minimumAmountOut = out/(1+s)`.
- alcor-ui `SwapWidget.vue`: quote fetched on 600 ms debounce; **no
  re-quote at submit**; memos signed as returned.
- alcor-ui `store/amm/index.js`: pools via `fetchAllRows(rpc, pools)`;
  ticks via `fetchAllRows(rpc, { scope: poolId, table: "ticks" })`;
  pool updates via socket.io `swap:pool:update`, batched 2.5 s.
- alcor-v2-sdk `main`: Q64 tick math (`tickMath.ts:106`),
  `MIN_SQRT_RATIO = 4295048017`, `computeSwapStep` pure bigint, MIT.
- On-chain (wax.greymass.com, 2026-09-19): pool 217 row
  (112 613.008 WAX / 4 565 638 459 LEEF, sqrtPriceX64
  29663563357779418305, tick 9501, liquidity 20 077 984 976 034 — API
  agrees); 22 initialized ticks incl. ±443 580 full-range and
  concentrated bands; `ticks` table readable with `scope=217`,
  `more:false`.
- Hyperion (wax.eosusa.io, 2026-09-19): `logswap` live; action payload
  carries poolId, sender/recipient, signed tokenA/tokenB, post-swap
  sqrtPriceX64/liquidity/tick/reserves, trx_id, global_sequence.
- WAX Terminal bundle: header comment "there is no server anywhere in
  this application"; `recentSwaps` time-windowed logswap paging with
  global_sequence dedupe; `watchPoolTrades` 7 s / hidden-tab pause /
  backoff to 60 s; `venueDeltas` per-pool get_deltas replay.
