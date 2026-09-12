# Changelog

All notable changes to LEEF Trader. Dates are commit-era, not release tags.

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
