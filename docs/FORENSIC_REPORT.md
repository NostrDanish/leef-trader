# LEEF Trader — forensic recovery report

**Date:** 2026-09-12
**HEAD at investigation start:** `3c229cb` (“fix: surface HTTP 500 root cause…”)
**Production at investigation start:** `https://wax-auto-trader.shakespeare.wtf/` serving `main-I5AM7ZNY.js` — **not HEAD**. Production is `5a197c8` (coordinator), which already has the Alcor 500 but **does not** have the untested HEAD crash.

This report is evidence, not a commit-message paraphrase.

---

## A. REGRESSION

The trader did not “stop working” because of one bad commit. Two layers stacked:

### A1. HTTP 500 — not introduced by our code; triggered by our slippage values

Alcor `GET /api/v2/swapRouter/getRoute` does:

```js
slippage = slippage ? new Percent(parseFloat(slippage) * 100, 10000) : new Percent(30, 10000)
```

`Percent` feeds that product to `JSBI.BigInt`. **IEEE-754 values whose `× 100` is not an integer throw.** Express 4’s outer catch (alcor-ui commit `bde94220`, 2026-07-06 — “500 instead of hang”) turns the throw into **HTTP 500 `Internal error`**.

Live reproduction against `wax.alcor.exchange` on 2026-09-12 (same pair, same amount, only `slippage` changed):

| slippage | HTTP | `slippage * 100` in IEEE-754 |
|---|---|---|
| 0.6, 0.8, 1, 1.05, 1.2, 2.5 | 200 | exact integer |
| **1.1, 0.55, 2.2, 2.3, 0.29, 0.14, 0.125, 4.35** | **500 Internal error** | 110.00000000000001, 55.00000000000001, … |

This is **deterministic** (1.1 × 3 = 500) and **pair-independent** (LEEF→WAX 1.1 also 500).

How we send that value:

1. Bot knob `min=0.1 max=3 step=0.1` — **1.1 is a valid slider stop.** Default 0.6 is safe; any user who moved the knob to 1.1% hits 500 on **every** quote (buy, sell, arb, rebalance, manual).
2. Quotes desk chips include **1%** (safe) but the store default is 0.5 (safe).
3. Rebalancer default 0.8 (safe).
4. **`quoteArbPlan` (since `0478634`, Phase 2 arb floor)** re-quotes the sell leg with `Math.min(slippagePct, slipMax * 0.9)`. `slipMax * 0.9` is almost never an Alcor-safe decimal (`0.30000000000000004` → 500). This path fires on **spread arb and volume echo** even when the user left slippage at the safe default 0.6.

So: trading “worked better” on 0.6% / no arb re-quote. It “broke” as soon as (a) the user set 1.1% or (b) an arb/echo needed a tighter min-out. That matches “it happens across strategy/rebalancing paths.”

### A2. HEAD `3c229cb` is itself broken (and was never executed)

The latest commit claimed a 500 “fix.” The diff only **labels** the 500 (FetchContext) and **backs off 30s**. It does not change the slippage query string. It also:

- References `DEFAULT_OPERATIONAL_RESERVE_USD` in `bot-engine.ts` **without importing it** → `Uncaught ReferenceError` (confirmed in the live preview console, 15 repeats).
- Calls `tokenAmountForUsd` in `usdToTokenBounds` **without defining it**.
- Classifies Alcor 500s as `SLIPPAGE_TOO_HIGH` because FetchContext embeds `slippage=` and `/slippage/.test(m)` runs **before** the new QUOTE_FAILURE branch — so the 30s backoff **never fires** on the actual production 500.
- Did not bump the bot store version after adding `operationalReserveUsd`; `b.risk.operationalReserveUsd.toFixed` would throw on persisted v7 state.
- Tests were written and **explicitly not run**.

**Do not deploy `3c229cb` as-is.**

### A3. What still works (and should be kept)

Working architecture from `c460a53` → `5a197c8`, classified:

| Subsystem | Grade | Note |
|---|---|---|
| Session-key + WCW/Anchor signers | GREEN | In-memory only; policy firewall in front |
| Policy firewall | GREEN | Allowlisted contracts/actions/tokens |
| fetchJson host cap + 429 backoff | GREEN | Real 429 path; 500 is not 429 |
| RPC provider pool + no rebroadcast | GREEN | UNKNOWN lock is real |
| Reconciliation | GREEN | Chain transfers beat quotes |
| NetEdge + cost model | GREEN | Entries gated; exits not |
| Auto strategy selector | GREEN | Ranks arb / signal / meanrev / grid; volume last |
| Canonical balances SYMBOL@CONTRACT | GREEN | `376fa57` |
| Capital coordinator (manual + rebalancer) | GREEN | Same lock as bot `beginSigning` |
| Portfolio governor | YELLOW | Can resize; was over-blocking, then repaired in `27c5b7f` |
| Local CP router (ranking) | YELLOW | Heuristic; live Alcor quote is still authority |
| HEAD 500 “fix” | RED | Labels the symptom, crashes the app |
| Opportunity queue module | BLACK | Tests only; not on the live path |

No whole-system rewrite is justified.

---

## B. HTTP 500 — exact root cause

**Origin:** Alcor swap router, not WAX RPC, not Hyperion, not Shakespeare, not CORS proxy.

**Endpoint:** `https://wax.alcor.exchange/api/v2/swapRouter/getRoute`

**Request:** `trade_type=EXACT_INPUT&input=…&output=…&amount=…&slippage=<IEEE-unsafe>&receiver=…&maxHops=…&v2=true`

**Response:** `HTTP/1.1 500` body `Internal error` (plain text, not JSON, no eosio_assert).

**First failure in the chain:** constructing `new Percent(parseFloat(slippage)*100, 10000)` on Alcor’s server.

**Not:** stale book, rate limit, invalid amount, invalid token, wrong precision, contract assert, RPC exhaustion.

A *different* historical 500 class (`eosio_assert` / `invalid amount`) was already addressed in `18b5164` / `0585acd` (scientific notation, 180-char body slice). That is **not** this 500. This body is literally the two words `Internal error`.

---

## C. EXECUTION — what was actually broken

Pipeline:

```
MarketEngine snapshot
  → evaluateBot (strategy)
  → usdToTokenBounds (wallet-safe size)
  → governTrade
  → fetchAlcorRoute / fetchAlcorRouteCached   ← BREAKS HERE on unsafe slippage
  → policy → sign → push (one shot)
  → reconcile
```

Every live path that needs an executable Alcor memo goes through `fetchAlcorRoute`:

- bot buy / sell (`signAndPushSwap` → uncached quote at sign time)
- bot arb/volume (`quoteArbPlan` + possible `slipMax * 0.9`)
- rebalancer `quoteLegs`
- quotes desk `executeSwap`

There is **no remaining raw `fetch()`** on those paths. `session.ts` still uses `fetch` for Wharfkit wallet plumbing only.

Secondary execution bugs found and fixed in this recovery:

1. Missing import / missing `tokenAmountForUsd` (HEAD unbootable).
2. Alcor 500 misclassified as slippage → no backoff.
3. No evaluation mutex: overlapping snapshot + on-chain-spot ticks could paper-fill the same clip twice. Live capital lock already covered live double-spend; paper did not.
4. `operationalReserveUsd.toFixed` without `?? 0`.

---

## D. ARCHITECTURE

**Preserve:** market engine, RPC pool, policy firewall, signers, net-edge, auto selector, canonical balances, coordinator, reconciliation, UNKNOWN lock.

**Simplify later (not this recovery):** unused `opportunity-queue.ts`; leftover LEEF-named fields (`amountLeef`, `entryWax`) are documented aliases.

**Do not rebuild** the router or the market engine. The 500 is a one-line encoding bug at the Alcor adapter, not a graph-search failure.

---

## E. ROUTING

Local CP optimizer (≤10 hops, splits, Defibox/Taco edges) is **ranking only**. Live Alcor CLMM quote is still required before sign (`buildTransfers` refuses model-only). That separation is correct.

Alcor itself **caps `maxHops` at 3** server-side (`Math.min(3, …)`). Sending 10 is ignored, not a 500.

---

## F. MARKET DATA

Hot path: tracked LEEF + aux pool ids, ~cadence 10–30s, on-chain `swap.alcor` spot between pulls. Cold path (tape, Defibox/Taco, remaining pools) does not block trades. Stale-book gate = `max(risk.maxQuoteAgeSec, syncSec+15)`. Adequate for a browser tab.

---

## G. CAPITAL

Live: one `trade-cycle` lock (`signing | broadcasted | reconciling | unknown`). Bot uses `beginSigning` directly; manual + rebalancer use `coordinateCapitalMovement` (same lock). Rebalancer additionally skips LEEF legs while the bot holds LEEF.

Paper: lock is not taken (by design). This recovery adds `cycleInFlight` so overlapping evaluations cannot double paper-fill.

Governor + `usdToTokenBounds` both reserve operating capital; they can both resize a clip. They cannot spend the same live capital twice.

---

## H. SIZING

`usdToTokenBounds` (after this recovery) computes:

```
spendableUsd = walletUsd − operationalReserveUsd
effectiveMaxUsd = min(configuredMax, spendable, positionHeadroom)
maxIn = effectiveMaxUsd / quoteUsd
if maxIn < minIn → HOLD
```

Tests (now actually written against a universe that includes WAX/LEEF so `requireTradePrice` can resolve):

- wallet $5 / min $10 → effective max $5 < min → no trade
- wallet $5 / min $1 / max $100 → cap $5
- $2 operational reserve on a $10 wallet → spendable $8

---

## I. STRATEGIES

Entries still flow through NetEdge (fail closed). Exits never do. Auto ranks by expected net USD; volume echo is last and budget-capped. Economically rational. Arb still uses local CP to *discover* and Alcor to *execute* — correct, as long as the Alcor slippage param is safe.

---

## J. AUTO MODE

Not a timer around one strategy. `evaluateBot` `case "auto"` collects arb + directional theses, ranks by net USD, else optional bounded echo, else HOLD with a reason. Genuine selection.

---

## K. REBALANCING

Does not fight an open LEEF bot position. Live sweeps are one atomic batch, confirmed before totals move, UNKNOWN locked. Paper parses Alcor asset strings (`36b0944`). Interval default 600s is present (was missing → NaN, never fired — `8d51f10`).

---

## L. TRANSACTIONS

States: signing → broadcasted → reconciling → confirmed | failed | unknown. UNKNOWN does not retry. Broadcast timeout in `sign.ts` marks UNKNOWN with the known `sha256(packed_trx)` and starts read-only reconcile. Correct.

---

## M. ON-CHAIN TRUTH

`waitForTransaction`: RPC inclusion first, Hyperion transfers second. Position/P&L use `assetDelta` when transfers exist; otherwise quoted estimate + later reconcile. Honest.

---

## N. TESTS

This environment has **no `node` / `npm`** (`which node` → not found). `3c229cb` was right about that and wrong to ship unrun tests.

What we can do here: `build_project` (esbuild-wasm) — production bundle.

What must be run on a machine with Node before treating this as proven:

```
npm test          # tsc + eslint + vitest + vite build
```

New/updated tests in this recovery (not executed here):

- `src/lib/wallet/alcor-route.test.ts` — IEEE-unsafe slippage encoding
- `src/lib/wallet/trade-error.test.ts` — Alcor 500 with `slippage=` in context is QUOTE_FAILURE, not SLIPPAGE_TOO_HIGH
- `src/lib/leef/risk-usd.test.ts` — fixture now includes WAX/LEEF so wallet-safe cases actually exercise `requireTradePrice`

---

## O. REMAINING RISKS

- Alcor can still 500 for other reasons (Rust route-finder down, missing pools). We now backoff 30s on QUOTE_FAILURE instead of spinning every cycle.
- Alcor silently caps hops at 3; local 10-hop ranking can pick a path the live router will not build. Fail closed on “no usable route,” not a fake fill.
- Defibox/Taco are model-only until the pair row is re-read; mixed routes are sequential min-out chained (fixed in coordinator era).
- Browser tab is not 24/7. Suspension resyncs; it does not daemonize.
- No remote signer. Keys stay in tab memory.
- Persisted Zustand still a footgun; migrate is merging but a future field without a version bump will `toFixed` of undefined again. Version is now 8.
- `opportunity-queue.ts` is unused. Auto already ranks in `evaluateBot`.
- Production URL will keep serving the 500 until this build is deployed.

---

## P. PRODUCTION STATUS

**PAPER READY / SMALL LIVE TEST READY after this build is deployed.**

Not **LIVE READY** until `npm test` has been run on a Node machine and a tiny live clip (well under the user’s min-trade, dedicated trading permission) has produced a confirmed fill with a non-500 Alcor quote at slippage 1.1% (the previously fatal knob) and at the default 0.6%.

Do not size up until that evidence exists.
