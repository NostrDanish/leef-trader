# Changelog

All notable changes to LEEF Trader. Dates are commit-era, not release tags.

## Unreleased — Treasure growth: grow 1–3 assets, HOLD with a why

Don't trade pairs. Grow assets.

Pick 1–3 treasures (LEEF 60 / WAX 30 / TLM 10) and a mode (Max /
Balanced / Compound). The Growth Brain maps holdings onto the book and
asks which one atomic swap or cycle increases those token counts.

- **Objective:** weighted target-unit growth (not USD P&L).
- **Constraint:** anti-destruction firewall (value drop, impact, exec
  probability, harvest floor). Paying an AMM fee to *acquire* treasure is
  allowed; dumping treasure to print a larger bag is not.
- **HOLD** is a successful decision and the desk always shows why.
- Target-unit P&L on the desk: LEEF +3,842 · portfolio value · mix bars.

Uses the existing swap path (fresh Alcor quote, governor, no rebroadcast).
Never promises growth — seeks positive expected target growth, else HOLD.

---

## Unreleased — Volume extreme + Unleashed + hops cap + mixed clip sizes

- **Volume extreme**: any held token → LEEF tape (or LEEF → quote). Prefers
  profit, accepts zero-loss after LP fees. Mixed clip sizes inside min–max.
- **Unleashed**: trade-only mix of arb, echo, tape, next-hop, signal,
  mean-reversion. No extra knobs. HOLD only if the wallet/book cannot trade.
- Min/max is a **band**, not an order size: each clip is picked inside it
  from wallet + route ($2 here, $0.001 there).
- **Max hops** user setting (1–10). Strategies pick ≤ that cap, not always 10.
- Still: wallet check, fresh Alcor quote before sign, no rebroadcast.

---

## Unreleased — next-action: one graph per tick, cycles only on stables/WAX

planNextAction rebuilt the full route graph once per holding×destination
(~60 searches). Now: build once, rank destinations by TVL (top 8), scan
at most 6 holdings, and only search same-asset cycles on WAX/stables.
HOLD still wins when nothing clears.

---

## Unreleased — holdings-based next hop; HOLD is a trade

The route graph already had WAX/LEEF/TLM/USDC/TACO as nodes. Auto only
asked "buy LEEF with WAX?". `planNextAction` now asks: given what I
actually hold, what ONE atomic swap or cycle is worth doing?

After that fill the engine rebuilds. There is no predetermined
WAX→LEEF→WAX continuation. If LEEF→TLM is worse than the floor: HOLD.

Same-asset cycles (WAX→…→WAX) are allowed when they print net USD.
Live Alcor quote still required before sign.

---

## Unreleased — surgical brain fixes (no rewrite)

ChatGPT audit vs code:

- Pool-ID collision: **false**. Defibox/Taco ids are already namespaced
  (`1_000_000` / `2_000_000`). Tests already prove `alcor:217` ≠ `defibox:12`.
- Split hops: **true**. `routeHops(split)` returned 1. Now hops=1,
  actions=leg count; exec probability penalizes extra actions.
- Signal confidence used twice: **true**. Vote already gates entry
  (`minConfidence`); it no longer also scales expected gross AND EV.
- Fake VWAP: **true** for the bot series (volume=1). VWAP stays on the
  chart, off the bot vote.

Not rebuilt: market engine, RPC, firewall, CLMM live quote at sign,
capital lock, Auto as orchestrator.

---

## Unreleased — LEEF price is not $0: quote per 10M + enough USD digits

1 LEEF ≈ $0.00000019 / 0.00000004 WAX, so 6–8 decimal USD printers
showed $0.00. fmtUsd now keeps going to 10–12 dp for dust. Human quotes
are per **10,000,000 LEEF** (≈ 40.87 WAX / ≈ $1.90 WAXUSDC) with a
precise 1 LEEF line underneath. Wallet / portfolio / header / overview /
tick / pools all use that.

---

## Unreleased — type 0.00004, no fake paper bag, searchable pair

- Min/max USD fields keep a typing draft: `0.` / `0.000` no longer snap
  back to `0` on every keystroke. Commit on blur.
- Fake paper wallet (8M LEEF / 250 WAX / dust tokens) wiped. Unsigned
  mode is an empty wallet on the live Alcor book.
- Base/quote pickers are searchable. WAX is never a base; LEEF is never
  a quote. Store setters reject those swaps.

---

## Unreleased — WAX micropayments: dust clips + volume maker lives again

WAX with staked CPU/NET/RAM has no transfer fee. The previous "smart"
gates charged $0.002/tx, demanded $0.0001 profit and 70% execution
probability on 2-hop Alcor echos, and the min-trade slider could not go
below $0.01. That silenced volume maker and blocked 3000×$1e-10 fills.

- Cost model `txCostUsd = 0` (staked). Renters can still override.
- Min trade default $0 (one token quantum); max position default $100.
  UI is a number field so you can type $0, $0.00000001, $1, $50, $100.
- Volume stays `intent: "volume"` even when slightly green, so it is not
  promoted into the profit gate. Allowed when round-trip cost ≤ echo
  budget (zero-loss average after LP fees). On-chain min-out still reverts
  anything worse.
- Profit gate no longer demands a cent or 0.1% — a $1e-10 net is a win.
- Execution-probability floor 0.35 (2-hop Alcor is normal, not a sit-out).

---

## Unreleased — common Opportunity engine; Auto is the orchestrator

- Strategies no longer execute (or Auto-rank) on raw net-USD or headline
  percent. Every proposal — signal, mean-reversion, grid, DCA, spread arb,
  volume echo — is scored by `src/lib/leef/opportunity.ts`:
  `expectedNetProfitUsd × executionProbability × freshness × inventoryTilt × calibrationHaircut`.
- Auto only ranks already-scored candidates and picks ONE (or none). A
  +0.9% 1-hop deep clip beats a +1.8% 3-hop thin clip when EV is higher.
- Inventory tilt rewards underweight LEEF and penalizes overweight buys;
  it never turns a losing trade into a winner.
- Volume must clear the same gate (cost/notional and execution probability);
  Auto only falls back to volume when nothing profitable exists.
- Failed clips get a fingerprint cooldown so the next cycle looks elsewhere.
- Predicted-vs-realized calibration now haircuts over-optimistic strategies
  after 3+ fills (still not an LLM).

---

## Unreleased — recover Alcor quotes (HTTP 500) + unbootable HEAD

Forensic report: `docs/FORENSIC_REPORT.md`.

- **P0 HTTP 500:** Alcor `getRoute` crashes (`new Percent(parseFloat(slippage)*100, 10000)` → JSBI) on any slippage whose `×100` is not an IEEE-754 integer (live: 1.1, 0.55, 2.2, `slipMax*0.9`). `fetchAlcorRoute` now encodes slippage via `formatAlcorSlippageParam`, walking **down** (never widening) to a two-decimal string Alcor accepts. Single chokepoint — bot, arb re-quote, rebalancer, quotes desk all go through it.
- **P0 HEAD crash:** `DEFAULT_OPERATIONAL_RESERVE_USD` is imported in `bot-engine.ts`; `tokenAmountForUsd` is defined and exported. Preview was throwing `Uncaught ReferenceError` in a loop.
- Alcor 500s whose FetchContext contains `slippage=` are classified as `QUOTE_FAILURE` (30s backoff), not `SLIPPAGE_TOO_HIGH`.
- Bot evaluation mutex (`cycleInFlight`) so overlapping snapshot + on-chain-spot ticks cannot double paper-fill.
- `operationalReserveUsd.toFixed` is null-safe; bot store migrate version 8.
- Wallet-safe sizing tests now include WAX/LEEF in the universe so they actually hit `requireTradePrice`.

---

## Unreleased — reliability-first execution coordinator

- Fixed mixed multi-hop verification: every sequential leg now spends the
  previous leg's freshly guaranteed min-out (not a stale modeled input or
  optimistic output). Split slices remain independent. Defibox/Taco token
  identity is verified by symbol + contract before quote construction.
- Added one global capital-movement coordinator used by manual swaps,
  rebalancer and LP actions (the bot already uses the same underlying lock).
  Strategies can no longer race and spend the same inventory.
- Rebalancer no longer records a broadcast as a fill: it waits for chain
  confirmation, keeps UNKNOWN capital locked, reconciles transfers, refreshes
  balances and only then updates moved/swept totals.
- Added explicit execution failure policy: stale quote → requote; liquidity
  movement → reroute; transient RPC/API → refresh preparation once; policy,
  risk, min-out, rejection and UNKNOWN → never retry. Transactions themselves
  are never retried.
- Added ranked opportunity-queue primitives: profit actions outrank maintenance
  and controlled volume, candidates rank by net USD rather than headline edge,
  stale candidates and volume-loss/notional budget breaches are rejected, and
  only one action may be selected.
- Generic portfolio equity/drawdown now marks every canonical holding exactly
  once through the same authoritative USD oracle rather than only WAX + LEEF.

---

## Unreleased — canonical holdings display

- Fixed Wallet holdings rendering both compatibility aliases (`LEEF`) and
  canonical balances (`LEEF@leefmaincorp`) as separate rows. Each real
  SYMBOL@CONTRACT asset now appears exactly once; its contract is secondary
  identity text rather than another holding.
- Fixed canonical balance lookup case normalization (`WAXUSDC@eth.token` no
  longer misses a lowercase stored key), which also protects sizing and LP
  availability checks from false zero balances.
- Wallet holdings now use a single token mark instead of the two-token pool
  pair icon that incorrectly prefixed every asset with LEEF. LP balance checks
  now use the exact token contract rather than a bare symbol.

---

## Unreleased — restore trade flow + static market UI

- Fixed a recent prediction/execution regression: verified stable anchors with
  weak local pools can size candidates again (final executable venue quote and
  min-out still decide execution), and profit trades that improve an already
  concentrated imported wallet are no longer rejected merely because one
  small trade cannot repair the entire allocation.
- Portfolio Governor now blocks only newly created or worsened concentration;
  reserve preservation, depeg rejection, stale prices and policy/resource
  protections remain unchanged.
- Removed the duplicated animated market marquee, pause/play controls,
  synthetic candle/noise generation, chart indicators and ticker tuning UI
  (including the now-unused chart/strip components). The single top status row
  now shows only authoritative LEEF/WAX prices, current conversion, route and
  the existing sync countdown.
- Added explicit PRICE_UNCERTAIN and PRICE_DEPEGGED execution classifications
  and regression tests for weak stable references and improving trades.

---

## Unreleased — price oracle + execution state + portfolio governor

- Authoritative contract-aware `TokenPriceOracle`: portfolio and risk prices
  now carry source, age, confidence, liquidity, raw market observation and
  stable target/deviation/state. Weak/tiny stable observations cannot turn 53
  WAXUSDC into $23; stressed/depegged/uncertain prices are blocked for trading.
- Canonical wallet balances use `SYMBOL@CONTRACT`; bare-symbol aliases exist
  only when one held contract is unambiguous. `findToken` and `metaOf` now fail
  closed on same-symbol contract collisions.
- Compact `ExecutionMarketState` replaces the bot/manual swap's second full
  snapshot rebuild: only route-critical Alcor pools and price references are
  refreshed if stale, then the existing fresh executable venue quote remains
  mandatory before signing.
- Portfolio Governor simulates after-trade inventory, preserves absolute USD
  operating reserves, enforces concentration bands, and can resize strategy
  proposals to deployable capital. Profit, rebalance, and volume intents are
  classified separately.
- Rebalancer quotes run with bounded parallelism (three by default) rather than
  serially; `fetchJson` now cancels obsolete queued requests and reports queue,
  network, parse and total latency.
- Portfolio holdings show unit price, USD value, price source, confidence,
  liquidity and stable state; the Infrastructure desk includes expanded
  request/oracle/size/risk timing counters.

---

## Unreleased — persistent market engine + provider failover + stable fix

The app is now a persistent Antelope trading engine with a React terminal
attached (see `docs/MARKET_ENGINE.md`).

- **Zero page refresh**: a singleton MarketEngine (`src/lib/market/`) owns
  the block heartbeat, market pulls, on-chain spot reads, balance sync, the
  bot loop and the rebalancer. React subscribes
  (`useMarketEngine`/`useSyncExternalStore`); mounting/unmounting components
  never stops trading. No reload is ever needed for prices, routes,
  balances, portfolio or tx status — and market updates never re-import the
  signing key (memory-only by design).
- **Health-scored RPC failover** (`src/lib/wax/provider-pool.ts`): 8-node
  WAX RPC pool + 5-node Hyperion pool, scored on success × block-lag
  freshness × latency; failed reads fail over to the next-best node,
  repeated failures cool a node out and a background probe restores it.
  Nodes > 6 blocks behind (or with a wrong chain id) never broadcast
  transactions. Endpoint lists are editable at runtime (Infrastructure
  desk → Endpoints).
- **No-duplicate broadcast**: transactions are submitted once to a
  trading-eligible node; the txid (`sha256(packed_trx)`) is known before
  broadcast, so a network timeout locks capital as UNKNOWN with a known
  txid for reconciliation instead of re-signing/re-broadcasting. There is
  exactly one submission attempt — no automatic transaction failover.
- **On-chain pool state** (`src/lib/wax/alcor-onchain.ts`): hot pools are
  re-read straight from `swap.alcor`'s `pools` table
  (`currSlot.sqrtPriceX64`/`tick`, Alcor v2 SDK pattern) between API pulls —
  prices and strategies move at chain speed, not API cadence.
- **Dependency-aware route invalidation** (`route-cache.ts`): pool version
  counters; a route stays valid while none of its pools changed. Unrelated
  pool changes never invalidate it; browser resume discards everything.
- **Browser suspension handling**: timer-drift + visibility/online/focus
  detection → on wake: resync from chain truth, discard stale routes,
  balance refresh; a stale book is never traded.
- **Stablecoin/canonical fix**: trusted stable registry by SYMBOL@CONTRACT
  (`WAXUSDC@eth.token` etc.) with PEGGED/…/DEPEGGED oracle states — 53
  WAXUSDC now values ≈ $53; symbol clones on foreign contracts are no longer
  treated as $1 stables or allowed to hijack prices
  (`attachUsdPrices`, `universe.ts`, `cost-model` all contract-aware).
- **Infrastructure desk** (nav → Infra): chain head/age, per-endpoint
  health (latency/block lag/score/tx-eligibility), market state, route
  stats, signer + automation phase, engine/trade cycle timings, suspension
  history, endpoint editor. Status bar gains live chain/signer/auto dots.
- Tests: provider failover/lag/timeout/cooldown/restore, stable oracle and
  the 53-WAXUSDC valuation, clone isolation, route invalidation, on-chain
  row parsing/patching, engine state surface.

---

## Unreleased — 10s floor + invalid-amount quotes

- Live sync / cooldown / rebalancer check floor is **10 seconds** (was 5).
- Alcor quote `amount` and on-chain assets are formatted at exact token
  precision — no scientific notation (`1e-8 WAX` was an invalid amount).
- Chain `eosio_assert` HTTP 500s surface as `invalid amount` /
  `TRANSACTION_REJECTED`, not a raw UNKNOWN blob.

---

## Unreleased — cooldown 5s–30m

- Bot **Cooldown** slider: 5 seconds to 30 minutes (was 30s–10m). Adaptive
  floor dropped from 15s to 5s so a 5s setting actually fires.
- Rebalancer **Check every** already 5s–30m.

---

## Unreleased — live / 5s book sync

- Status bar **Sync** control: Live (5s), 10s, 15s, 30s, 60s, plus a 5–60s
  slider. Book poll, countdown, bot quote-age, and rebalancer check floor
  all follow it. Default stays 30s.

---

## Unreleased — rebalancer fills + hourly cap

- Paper sweeps parse Alcor asset strings (`"12.34 LEEF"`) instead of
  `Number(...)` which always became 0 and wiped the paper bag.
- Dust legs are sized to the USD leg cap, not the entire holding.
- Quotes use the 0–10 hop router (was 2 hops) and the cached Alcor path.
- Token universe is seeded from the live book so holdings price before the
  11 MB full list lands. Policy catalog includes aux + universe tokens.
- Live sweeps refuse to sign on exhausted CPU/NET/RAM.
- Trades / hour slider max raised from 30 to 120.

---

## Unreleased — hot-path speed + USD value risk

- Snapshot hot path is market state only (tracked pools + prices). Tape,
  remaining pools, and Defibox/Taco topology refresh in the background and
  no longer block `runBotOnce`.
- Live confirmation prefers RPC inclusion (~1.2s budget) over Hyperion
  indexing. Transfer parse continues asynchronously. UNKNOWN still never
  retries.
- Fetch layer: HIGH/MEDIUM/LOW priority so analytics cannot starve quotes.
- Alcor quotes: 5s timeout, 1.2s dedupe cache, inflight coalescing.
- Defibox/Taco live legs re-read the on-chain pair row; MODEL_ONLY is not
  executable.
- User-facing risk is USD: `minTradeUsd` $0.01 / `maxPositionUsd` $1,000.
  Token amounts are derived at the live quote-token mark. Old WAX clip/max
  are **not** interpreted as dollars.

---

## Unreleased — pair + focus scan (not only LEEF/WAX)

- Bot trades a **base/quote** pair (LEEF/WAX, LEEF/WAXUSDC, LEEF/PARAUSD, …).
  Focus chips bias the wallet scan. Scan suggests pair + clip/max/cooldown
  from balances and CPU/NET/RAM; you apply or ignore. Router hops if there
  is no direct book.

---

## Unreleased — dynamic clip band + pre-trade re-optimize

- `minTradeUsd` is the **minimum** notional; `maxPositionUsd` is the **ceiling**
  (minus currently marked exposure). Each entry picks a token size in that
  converted band.
- Immediately before sign, size + route are scanned again on the current
  book so the fill is not the 30s-old candidate.

---

## Unreleased — Defibox + TacoSwap venue adapters

- Universal liquidity graph: Alcor + Defibox (`swap.box` pairs table) +
  TacoSwap (`swap.taco`). Same optimizer, no second router, no venue bias.
- Policy firewall allowlists those AMM contracts with venue-specific memos.
- Live: all-Alcor still requotes CLMM; Defibox/Taco use on-chain min-out
  memos; mixed hops are one atomic tx.
- Spread arb also scans venue LEEF/WAX books (cross-DEX round trips).
- Discovery is on-chain tables, cached 120s, fail-open if a venue is down.

---

## Unreleased — safe dominance, depth-aware branching, ternary size search

- Token-only dominance removed. A state is pruned only if another has ≥
  output, ≤ hops, and a **subset of used pools** (conservative Pareto).
- Branching is no longer "top 8 quotes". Union of best quotes + deepest
  books; all edges if a node has ≤16 exits. Weak first hops can still win.
- Optional 3-book residual on top of the 2-book golden-section split.
- Size scan: coarse ladder then **ternary refine** (unimodal assumption).
- Docs: ROUTING.md states the search is a **bounded heuristic**, not globally
  optimal. Adversarial tests for the old prune bug and a non-top-8 first hop.

---

## Unreleased — 0–10 hop economics + numerical splits

- Router cap is **10 hops** (`MAX_ROUTE_HOPS`), searched with dominance
  pruning and a branch factor — not brute force. Extra hops have **no
  arbitrary 0.4% haircut**; they win only if destination output is higher.
- Two-book splits use **golden-section allocation**, not a 70/30 ladder.
- Entry size: coarse ladder then **local refinement** around the winner.
- Live Alcor `maxHops` follows the local plan up to 10.

---

## Unreleased — execution router + strategy quality

### Added

- **ExecutionRouteOptimizer** (`lib/leef/route-optimizer.ts`): graph search
  over Alcor pools (up to 3 hops), hop penalty so extra legs must pay, and
  split routing when two books beat a single clip. Buy Now / Sell Now / bot
  entries / net-edge sizing all use this for the **exact** trade size.
- Live Alcor quotes request `maxHops` matching the local plan (default 3).
- Split fills execute as one atomic batch on-chain (or sequential paper fills).

### Strategy quality (kept, not replaced)

- Signal: fade expected edge when short-term momentum is negative.
- Mean reversion: block entries in a strong downtrend (12-print momentum < −4%).
- Grid: adaptive step from fees + realized vol (still respects the configured floor).
- DCA: skip a clip into a short-term spike.
- Spread/volume: size ladder — pick the clip that maximises **net WAX**, not %.

### Tests

- Router: small vs large size, buy/sell asymmetry, hop beats thin direct,
  direct beats worse hop, split only when it pays, spoofed LEEF rejected,
  illiquid size → no trade.

---

## Unreleased — economic core + execution hardening

### Added — economic engine

- **TradeCostModel** (`lib/leef/cost-model.ts`): the single authoritative
  cost calculation — round-trip execution (AMM fee + impact measured exactly
  once against USD mids), slippage allowance, volatility-driven opportunity
  decay, WAX resource cost, failure cost.
- **NetEdgeEngine** (`lib/leef/net-edge.ts`): net edge after all costs,
  profit-maximizing trade-size scan (interior maximum — the best size is
  often smaller than the clip), and an explainable 0–100 opportunity score
  with per-factor breakdowns.
- Every bot entry (signal / mean reversion / grid / DCA) now flows through
  the edge engine with a strategy-anchored expected move; entries that can't
  clear `minNetEdgePct` after costs are declined. Doing nothing is a valid,
  logged decision.
- **Quote freshness gate** (`maxQuoteAgeSec`, default 45s): stale book → hold.
- **Adaptive cooldowns**: 0.5× for atomic arb/echo, 2× for DCA, 1.5× after a
  losing trade; 15s floor retained as runaway protection.
- **Strategy calibration memory**: per-strategy predicted-vs-realized edge,
  P&L, wins and execution latency (`stats.byStrategy`).
- **Opportunity dedup**: the rebalancer defers LEEF-selling legs while the
  bot holds an open LEEF position.

### Added — execution + safety

- **Transaction policy firewall** (`lib/wallet/policy.ts`): every action list
  validated before any signer sees it (allowlisted contracts/actions,
  verified token contract+precision, receiver pinned to the account at
  swap.alcor, well-formed memos only).
- **Arb profit floor on the actual transaction**: the sell legs' on-chain
  min-outs must sum to ≥ stake × (1 + floor); verified in the bot loop and
  again at the signing boundary. The sell leg is re-quoted with a tighter
  slippage guard when the quote clears the floor but the min-out doesn't.
- **Chain reconciliation** (`lib/wallet/reconcile.ts`): post-broadcast
  Hyperion lookups; positions and P&L settle from actual transfers
  (confirmed / failed / unknown — unknown is never blind-retried).
- **WAX resource preflight**: CPU > 95% / NET > 98% / RAM > 98% → no signing.
- **Emergency stop**: header button halts bot + rebalancer, preserves
  positions, requires deliberate restart.
- RAM monitoring in `accountResources` + wallet store.

### Fixed — correctness bugs

- **Arb profit floor was not enforced on the router path** (the documented
  guarantee didn't match the transaction). Now enforced on the memos' min-outs.
- **Live fallback to the local constant-product model on router failure** —
  removed. Live execution is router-exact or nothing.
- **`expectedOut` was silently the local estimate**: `Number(quote.output)` is
  NaN on "123.45 LEEF"-style strings; now parsed with `parseAssetAmount`.
- **Token identity accepted any non-empty contract for "LEEF"** (and an empty
  contract for "WAX") — spoofed tokens could feed pricing/routing. Now exact.
- **Rebalancer never fired on schedule**: `intervalSec` was used by the loop
  and the desk UI but missing from `RebalanceSettings`/`DEFAULT_REBALANCE`
  (NaN interval, perpetual "not due"). Added with a 600s default.

### Changed

- `package.json`: `mkstack` → `leef-trader` 0.1.0; scripts no longer run
  `npm i` on every invocation; added `lint` / `typecheck` / `preview`.
- Decision journal entries carry net edge, score, confirmation status and
  txid for every trade.
- Removed `lib/wallet/memo.ts` (dead local-fallback memo builder).

### Tests

- New suites: policy firewall, signer reference vectors (Wharfkit),
  reconciliation parsing, resource gate, token identity, cost model,
  size optimizer, bot edge gate.

### Documentation

- README rewritten; `docs/` added: ARCHITECTURE, TRADING_ENGINE, NET_EDGE,
  TRADE_COST_MODEL, STRATEGIES, RISK_MANAGEMENT, SECURITY, WAX,
  CONFIGURATION, TESTING.

## Prior history

See `git log` — terminal port onto MKStack, bot strategies, atomic arb,
multi-token rebalancer, volume maker, WCW/Anchor login, session-key import,
mobile polish, rate-limit hygiene.
