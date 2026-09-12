# Market Engine — the persistent trading core

Status: reflects the code as it exists today (`src/lib/market/`,
`src/lib/wax/`).

LEEF Trader is no longer "a website that happens to contain a trading bot."
It is a persistent Antelope trading engine with a React terminal attached.
The site loads **once**; from then on the engine owns every loop and the UI
merely subscribes.

```
┌─────────────────────────┐
│     WAX CHAIN STATE     │
└────────────┬────────────┘
             │
   ┌─────────┼──────────────────┐
   │         │                  │
RPC pool  Hyperion pool    Market APIs
(8 nodes) (5 nodes)        Alcor / Defibox / Taco
   │         │                  │
   └─────────┼──────────────────┘
             │
   CHAIN PROVIDER MANAGER (health-scored)
   src/lib/wax/provider-pool.ts
             │
   ┌─────────┼─────────────┐
   │         │             │
balances  pool state    tx status
   │         │             │
   └─────────┼─────────────┘
             │
   MARKET ENGINE  (singleton, src/lib/market/market-engine.ts)
   ├── block heartbeat (get_info every ~1.5 s — the chain is the clock)
   ├── market pulls (Alcor API, 10–60 s cadence)
   ├── on-chain spot (swap.alcor pools table between pulls)
   ├── balance watcher (Hyperion + RPC fallback)
   ├── route cache (dependency-aware invalidation)
   └── drivers: botOnSnapshot / rebalancerOnSnapshot
             │
   ┌─────────┼─────────────┐
   │         │             │
 prices    routes       holdings
             │
      STRATEGY ENGINE
             │
      FRESH EXECUTION QUOTE (Alcor router)
             │
      POLICY FIREWALL → SIGN → BROADCAST (single submission)
             │
      ASYNC RECONCILIATION (chain truth)
             │
      UI reacts (useSyncExternalStore — never a page refresh)
```

## The zero-refresh contract

| Event | What happens | What NEVER happens |
| --- | --- | --- |
| Price moves | engine patches pools from chain truth → UI re-renders | page reload |
| Route changes | dependency invalidation → recompute affected routes only | full recompute |
| Balances change | balance watcher updates the wallet store | key re-import |
| Trade confirms | reconciliation reads actual transfers | key re-import |
| RPC dies | failover to the healthiest node | bot dies |
| Tab suspends | gap detected on wake → full resync → stale routes discarded | trading from stale data |

The imported signing session (`secret.ts`, in-memory only) is completely
decoupled from market data. `WalletSession` (account / public key / signer)
and `MarketSession` (block / pools / prices / routes / quotes) are separate
concerns; market updates never create, destroy, or re-import the signer.
A genuine browser reload does require re-importing the key — by design, since
raw private keys are never persisted anywhere.

## Chain provider manager (`src/lib/wax/provider-pool.ts`)

Every chain call goes through one of two singleton pools — `rpcPool` (chain
API) and `historyPool` (Hyperion) — never through a hardcoded URL list.

### Health scoring

```
score = 100 × availability × successRate × freshness × latencyScore

availability  0 while cooling down / disabled
successRate   EWMA (α = 0.25) of call success
freshness     clamp(1 − blockLag/200, 0.05, 1)   ← chain truth, not speed
latencyScore  clamp(1 − (latencyMs − 80)/1720, 0, 1)
```

A node 140 blocks behind scores ~30 **and** is hard-rejected for trading.
Being fast is not a substitute for being current.

### Trading eligibility (transaction submission)

A node may receive a signed transaction only when:

- not cooling down / disabled,
- `chain_id` verified against WAX mainnet (wrong chain ⇒ permanently
  ineligible),
- head block known and **≤ 6 blocks** behind the network head,
- zero consecutive failures,
- success EWMA ≥ 0.5.

### Failover

- **Reads**: best score first → next → next. HTTP 4xx answers
  (eosio_assert etc.) are definitive and do **not** fail over; 5xx/429 and
  network errors do.
- **Cooldown**: 3 consecutive failures ⇒ cooldown 20 s, doubling per streak
  up to 5 min. The engine's heartbeat health-probes cooled nodes (~every 6 s)
  and automatically restores them when they answer.
- **Everything cooling**: the soonest-to-recover nodes are tried anyway — a
  dead RPC must not kill the engine.

### Transaction broadcast — the no-duplicate rule

`pushTransaction` submits the signed payload to ONE trading-eligible node.

- There is **exactly one submission attempt** — no automatic transaction
  failover, including on 5xx/429. Once signed, uncertainty is resolved by
  reads/reconciliation, never by creating or re-sending a transaction.
- **Network timeout ⇒ `BroadcastTimeoutError`. The payload is never
  re-broadcast.** The transaction id is known *before* broadcast
  (`txid = sha256(packed_trx)`, `antelope.ts`), so the trade-cycle
  immediately locks capital as `UNKNOWN` with that txid and reconciliation
  decides. An HTTP timeout does not mean the transaction wasn't accepted —
  assuming it wasn't is how double-spends happen.

## Endpoints (`src/lib/wax/endpoints.ts`)

Curated defaults (Greymass, EOS Rio, Sw/eden, EOSphere, WAXUSA, CryptoLions,
Blokcrafters, EOS Detroit — cross-checked against the Hyperion endpoint index
and the EOS Nation WAX endpoints report) plus a **runtime configuration**
layer: the Infrastructure desk edits endpoint lists in the browser
(localStorage `leef-wax-endpoints`), the pools hot-reload, no rebuild needed.
A self-hosted WAX node can simply be pasted into the list — the app doesn't
care who runs the node, it just sees `ChainProvider`.

## Block-driven market updates

The heartbeat polls `get_info` on the healthiest node every ~1.5 s. That
gives:

- the head/LIB used for freshness scoring,
- the **market state age** shown in the UI,
- the suspension detector (head not advancing while "running" ⇒ force pull),
- the cadence for on-chain spot reads.

### On-chain spot (`src/lib/wax/alcor-onchain.ts`)

Between API pulls (every ~4.5 s while the tab is visible) the engine re-reads
the **hot pools' rows straight from `swap.alcor`'s `pools` table** — the same
pattern as Alcor's own v2 SDK (`currSlot.sqrtPriceX64` / `currSlot.tick`).
Contiguous pool ids are fetched as small ranged `get_table_rows` reads, not
full scans.

If a row meaningfully changed (sqrt price, liquidity, reserves):

1. the pool is patched (prices from `sqrtPriceX64` when present),
2. USD prices are recomputed over the patched book (stable oracle included),
3. the route cache bumps that pool's version → affected routes invalidate,
4. strategies reevaluate — **chain truth drives trading decisions**, not the
   30 s API cadence,
5. unrelated pools/routes are untouched.

API state remains the convenience layer (discovery, volumes, TVL, tape); the
Alcor router remains the executable-quote layer; chain state is the truth
layer.

## Route invalidation (`src/lib/market/route-cache.ts`)

Every tracked pool has a version counter bumped when its fingerprint
(sqrt price, liquidity, reserves, spot) changes. A cached route records the
pool versions it was computed against; it stays valid while none of its
dependencies moved. `invalidateAll()` (browser resume) discards everything.

## Browser suspension

Browsers throttle timers in background tabs, during screen lock, and under
power saving. The engine never trusts old timers:

- drift detection in the heartbeat scheduler,
- `visibilitychange` / `online` / `focus` listeners,
- on wake with a gap ≥ 2.5× the cadence: discard route cache → fresh head
  block → fresh snapshot → fresh balances → resume trading,
- while hidden under 5 minutes: mark time only (no background request burn),
- a stale book (> cadence + 15 s) is **never** traded — the bot journals
  "not trading from stale data".

## Authoritative price oracle

`src/lib/market/price-oracle.ts` is the only economic interpretation layer
for token prices. Every `TokenPrice` includes:

- canonical `SYMBOL@CONTRACT` identity,
- portfolio/risk `priceUsd`,
- raw `marketPriceUsd`,
- source, timestamp/age, confidence and liquidity,
- stable target/deviation/state,
- `tradeAllowed` plus an actionable reason.

Trusted stables use a bounded model: PEGGED/MINOR observations use their deep
market mark; weak, tiny or divergent observations cannot turn 53 WAXUSDC into
$23, so accounting and candidate sizing stay at the verified stable anchor
while the divergent market value remains visible. A weak tiny pool alone does
not disable a verified stable route—the mandatory final executable venue quote
and min-out remain execution truth. Strong, liquid `DEPEGGED` evidence and
stale prices block trading. An unknown token merely containing "USD" never
receives the anchor.

Bare symbols are no longer economic identity. `findToken`, `metaOf`, balance
sync, holdings and risk sizing resolve `SYMBOL@CONTRACT`; a bare symbol works
only when exactly one contract is unambiguous. Hyperion balance rows are kept
as canonical keys, and compatibility aliases are emitted only for unique
symbols. Those aliases are indexes, not assets: `walletBalanceRows()` suppresses
them whenever the canonical key exists, so one balance can never be rendered
or valued twice. Canonical lookup normalizes contract case consistently.

## Background state vs execution state

The full snapshot remains the background state (universe discovery, tape,
analytics, venue topology). `src/lib/market/execution-state.ts` is the compact
pre-trade state: if the chain spot is older than eight seconds, it refreshes
only the candidate route's Alcor pool ids plus the WAX/stable references.
The bot and manual swap paths no longer call `getLeefSnapshot()` a second time
before capital moves. After the compact refresh, the venue adapter still
obtains a fresh executable quote immediately before signing.

## Portfolio Governor

`src/lib/market/portfolio-governor.ts` sits between Net Edge and Risk. It
simulates the complete post-trade portfolio and asks whether the proposal is
profitable **and** leaves the machine operational. Configurable canonical
asset bands define target/min/max shares and absolute USD reserves.

For each proposal it records before/after portfolio, requested and allowed
amount, reserve impact, concentration impact, state and reason. A strategy can
propose a $100 buy; the governor can resize it to the deployable $38, reject a
trade that creates/worsens concentration, or classify an intentional
maintenance trade as `REBALANCING`. A freshly imported wallet may already sit
outside target bands; economically positive trades that reduce its largest
concentration are allowed even when one clip cannot fully rebalance it. Profit
strategies cannot consume reserves; maintenance trades may repair an already
concentrated portfolio.

State model: RUNNING / WAITING / LOW_LIQUIDITY / ASSET_CONCENTRATION /
REBALANCING / BLOCKED. Security, resource, policy and unknown-transaction
errors remain hard blocks—they never trigger "buy something" behavior.

## Request scheduling and quote parallelism

`fetchJson.ts` retains its HIGH/MEDIUM/LOW queue and HIGH-reserved host slot,
adds cancellation while requests are still queued, and records queue wait,
network, parse and total latency. Obsolete low-priority requests leave the
queue before consuming a network slot. Rebalancer legs now quote with bounded
parallelism (default three); output order remains deterministic and the
existing per-host scheduler still limits Alcor load.

## Wallet session vs market session

- `WalletSession` — account, permission, auth type, signer (in-memory
  `secret.ts` for keys; Wharfkit for Cloud Wallet/Anchor). Created only by
  explicit user action; market refreshes never touch it.
- `MarketSession` — head block, pools, prices, routes, quotes. Owned by the
  engine, continuously rebuilt from chain/API truth.

## Instrumentation

- Engine cycle: market pull / on-chain spot / balances / bot evaluate /
  total — `EngineState.cycle`, shown on the Infrastructure desk.
- Trade cycle: route search / net edge / quote / sign / broadcast /
  confirmation / total — `trade-cycle.ts` timings, same desk.
- The **Infrastructure desk** (nav → Infra) shows chain head + age, every RPC
  and Hyperion endpoint (latency / block lag / score / tx-eligibility),
  market state (Alcor API + on-chain spot), route cache stats, signer
  session, automation phase, suspension history, and the endpoint editor.

## Reliability-first execution coordinator

`src/lib/wallet/execution-coordinator.ts` gives bot, manual swaps, rebalancer
and LP management one shared capital lock and transaction lifecycle. Only one
capital-moving action can sign/broadcast/reconcile at a time. A broadcast is
not a fill: rebalancer totals/logs update only after confirmation; UNKNOWN
keeps all affected capital locked and background reconciliation is read-only.
After confirmation, balances refresh from chain truth before another planning
cycle.

Mixed sequential routes chain amounts conservatively. Leg N spends leg N-1's
freshly verified **min-out**—the amount guaranteed by the on-chain guard—not
its stale modeled input or optimistic quoted output. Split routes remain
independent input slices. This prevents valid first-leg slippage from making a
later atomic action overdraw and revert.

`retry-policy.ts` classifies NO_OPPORTUNITY / STALE_DATA /
INSUFFICIENT_EDGE / INSUFFICIENT_BALANCE / RISK_REJECT /
TEMPORARY_RPC_FAILURE / EXECUTION_FAILURE / TRANSACTION_UNKNOWN. Only
pre-sign preparation can retry: stale quotes requote once, moved liquidity
reroutes once, transient RPC/API work refreshes once. Policy/risk/min-out,
transaction rejection and UNKNOWN never retry; transactions themselves are
never re-submitted.

## Opportunity scheduler primitives

`src/lib/market/opportunity-queue.ts` accepts candidates from profit,
maintenance and volume producers, applies quote-age and volume loss/notional
budgets, ranks by intent then expected **net USD** plus confidence/liquidity
and inventory improvement, and selects exactly one action. Profit ranks first;
maintenance can restore capability; volume is considered only inside its loss
and notional budgets. A high percentage on a tiny clip does not outrank a
larger net-USD opportunity.

## Generic accounting

`markPortfolioUsd()` values every canonical holding exactly once through the
same TokenPriceOracle. Bot starting equity and drawdown therefore include WAX,
LEEF, stablecoins and all other priced inventory. P&L can no longer appear
positive merely because value drifted into a token the old WAX+LEEF subtotal
ignored.

## Honest venue execution limits

Alcor is the only integrated venue currently exposing a fresh exact CLMM
router response with ready-to-sign min-out memos. Defibox and Taco legs are
re-read from their on-chain pair rows immediately before signing, then quoted
with their constant-product reserve math and an on-chain min-out memo. That is
fresh validation, but it is not an external exact router simulation. Such
legs remain subject to the existing `MODEL_ONLY` / liquidity-drift checks and
are never mislabeled as globally optimal. Route search itself is a bounded
heuristic over paths and numerical splits; extra hops win only when modeled
output is better and final execution validation succeeds.

## Low-motion terminal UI

The old UI-only live ticker was intentionally removed: no duplicated scrolling
price marquee, pause/play control, seeded candle path, synthetic noise,
indicator chart decoration or ticker tuning sliders run in the terminal. Those
calculations were never execution truth—the strategy engine maintains its own
real snapshot series. One static status row now shows authoritative LEEF/WAX
prices, current route conversion and the existing synchronization countdown.
The detailed market desk is a static pool/route table that updates only when
the MarketEngine publishes real state.

## Market-data priorities

HIGH (execution, fresh quotes, critical pool state, pre-trade balance) is
enforced by `fetchJson`'s per-host queue: at most 4 in-flight per host with
one slot reserved for HIGH. LOW (history, charts, full discovery) can never
starve HIGH.
