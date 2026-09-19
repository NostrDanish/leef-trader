# FUTURE — researched opportunities beyond the 2026-09 upgrade

Sourced from the 2026-09-19 recon of `alcorexchange` (org source, API docs,
live endpoints) and `flopsterino/waxterminal` (live app + public source).
Each item is scoped to layer onto the current architecture without touching
the KEEP list (see ALCOR_COMPARATIVE_AUDIT.md §6/§14).

## Decision point (evidence-gated)
- **E-3 local CLMM tick-walk quoter** — port the ~500-line Q64 math core
  (fullMath/sqrtPriceMath/tickMath/swapMath) from the MIT `alcor-v2-sdk`
  into `src/lib/wax/alcor-clmm.ts`; fetch `ticks` per hot pool
  (`get_table_rows`, scope = poolId), cache, refetch on liquidity change or
  60 s. **Verdict (live sweep 2026-09-19): NOT justified by the evidence.**
  The repo's virtual-CP formula was measured against Alcor's live router
  (execution truth) across 6 hot pairs: drift 0.000% (max 0.000021%) at
  every size the bot trades (0.5–200 WAX-eq). Drift only appears at
  15–100× bot sizes, and the worst in-cap case was 0.53% at ~3% price
  impact — inside the bot's 3% impact cap, which already rejects those
  trades. Building the tick-walk now would buy ~0 measurable accuracy.
  **Contingency instead:** if the journaled `venueImpactPct`/gateDrift
  evidence ever rises, first add the cheap 3-line distance-to-tick-boundary
  guard (compare trade size against the pool row's boundary input; sizes
  near the boundary get a router re-quote or a skip) — it captures most of
  the residual error without the Q64 port. Revisit E-3 only if that guard
  fires often, or as an availability feature: it remains the only way to
  keep producing executable quotes when wax.alcor.exchange is down (today:
  fail-closed SPOF). Never adopt the SDK package, WASM/Rust route-finders,
  or worker threads without profiling evidence.

## New venue: Alcor order-book DEX (`alcordexmain`)
- Orders are plain token `transfer`s with the ask in the memo
  (`<ask> <SYM>@<contract>`; `0.0000` = market order); cancel via
  `cancelbuy`/`cancelsell`; books readable from `buyorders`/`sellorders`
  (scope = market_id, i128 price index) or REST
  `/api/v2/tickers/:ticker/orderbook?depth=300` (Redis-backed, 1 s cache).
- Per-market `fee` (0.01% units), `min_buy`/`min_sell`, `frozen` flags.
- **Atomic book↔AMM arb**: both Alcor venues execute via transfers, so
  buy-book → sell-AMM composes as multiple actions in ONE transaction with
  all-or-nothing safety — a natural extension of the existing arb-floor
  policy check.

## Execution cost: free CPU payer
- Alcor's cosign service (`POST /api/v2/cpu/status`, `/api/v2/cpu/cosign`)
  uses `ONLY_BILL_FIRST_AUTHORIZER`: first action `liquid.alcor::noop`
  (auth `liquid.alcor@bw`), cosigned on their budget (limits: 300 req/
  account/h — plenty for a gated bot). Keep own stake as fallback; treat
  `throttled` as a normal skip. Whitelisted contracts cover `alcordexmain`,
  `swap.alcor`, transfers to them.

## Token safety as a filter
- Alcor v3 token **score** endpoint (traders/volume/liquidity/holders/
  activity/stability/age composite) + `?hide_scam=true` and the config
  scam lists — screen any pair before it enters the route graph. Kills
  fake-liquidity traps (waxterminal's measured real-vs-face TVL gap:
  $353k real vs $2.9M nominal chain-wide).
- `/api/v3/swap/pools/:id/liquidity-distribution?bins=120` — cheap
  slippage sanity histogram without tick math.

## Monetization (on-chain, receipt-verifiable)
- AMM swap memo's optional 6th segment = a registered `regmarket` account →
  referral fee share on own order flow (docs.alcor.exchange → referral
  custom market fee).
- waxterminal's paid promotion/ratings-via-memo model (self-serve,
  expiring, labeled, never affecting rankings) — zero-backend revenue that
  does not corrupt data.

## Data & speed
- **Cron-indexer/static-database pattern** (waxterminal): a scheduled
  GitHub Action sweeping chain state into compact committed JSON = free
  versioned CDN time series AND a backtest dataset (~6 MB/yr). The
  seed-snapshot prebuild shipped in the 2026-09 upgrade is the first step;
  extend granularity to 5-minute signal bars.
- `/v2/history/get_deltas` filtered by primary key = free per-pool
  price/liquidity event replay (charts/analytics; audit E-2).
- Alcor Socket.IO (`wss://wax.alcor.exchange/socket.io/`) rooms
  (`swap:pool:update`, `account:update-v2` invalidation hints) — only if a
  server relationship is ever acceptable; the Hyperion flow layer shipped
  in E-1 already delivers most of the value serverlessly.
- Hedged RPC reads: investigated 2026-09, verdict skip — see
  `docs/hedged-reads.md` for revisit criteria.

## Competitive checklist (WaxOnEdge + waxterminal gaps)
- WaxOnEdge already aggregates Alcor/Nefty/Taco/Defibox/A-DEX — A-DEX is
  the one venue neither we nor waxterminal execute on yet.
- waxterminal deliberately has NO in-app execution and 2-hour staleness;
  LEEF Trader already beats both. Their remaining UX leads worth copying:
  read-only any-account portfolio lookup (light-api), one-click
  compound/zap flows, watchlist "what moved since you looked" baselines.
