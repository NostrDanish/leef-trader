# Hedged reads — investigation verdict (feat/perf)

**Question:** should `provider-pool.call()` / `fetchJson` fire a hedge request
to a second host ~2 s after the first for idempotent GETs (first answer wins)?

**Verdict: NO — does not fit the existing design cleanly. Not implemented.**

## What exists today

- `ProviderPool.call()` (src/lib/wax/provider-pool.ts:434) is *sequential*
  failover, best-health first, driven by EWMA health scores
  (`scoreOf`/`latencyScoreOf`/`freshnessOf`) fed by `observeStart/Ok/Fail`
  and background `get_info` probes.
- `fetchJson` (src/lib/fetchJson.ts) enforces a per-host queue
  (max 4 in-flight, 1 slot reserved for HIGH priority), 429/503 host
  cooldowns with jitter, per-attempt timeouts, and a GET-only CORS-proxy
  guard. The codebase explicitly treats duplicate submission as a hazard
  ("exactly one submission" invariant; HTTP errors are "real answers —
  proxying them would just double the load").

## Why hedging doesn't fit

1. **Health-score pollution.** The hedge loser must be aborted (or it is
   pure duplicate load). An aborted in-flight attempt currently lands in
   `observeFail`, corrupting that host's `successEwma` and consecutive-
   failure streak for doing nothing wrong. A neutral "observeCancel"
   observation path would be a scoring-design change, not a local tweak.
2. **Duplicate-load amplification against rate-limited public infra.** The
   per-host queue + 429 backoff exist precisely because these are public
   BPs with nginx rate limits. Hedging doubles request volume for every
   read slower than 2 s — exactly the population of calls most likely to
   be hitting a loaded host, compounding 429s.
3. **Per-host queue semantics break.** A hedged pair occupies slots on two
   hosts for the same logical call; cancellation would need to propagate
   through `acquire()` waiters cleanly, and HIGH-priority reservation
   accounting assumes one slot per call.
4. **The tail-latency problem is already bounded differently.** Background
   probes keep health fresh, so chronically slow hosts stop winning
   `best()`; sequential failover caps the worst case at one `timeoutMs`
   (12 s default, overridable per call). Where cold-start latency matters
   (first paint), the seed snapshot removes the dependency entirely.

## Cheaper alternatives already in place (or done in this pass)

- Seed snapshot paints instantly; live chain state refreshes behind it.
- SessionKit chain URL now follows the pool's health-scored best with
  curated-list failover (session.ts), removing the single-host hardcode.
- If a specific hot read is ever measured to tail badly, prefer a shorter
  `timeoutMs` for that call (already a per-call option) — it bounds the
  failover delay without any duplicate traffic.

Revisit only if measurements show p99 read latency dominating time-to-live
*after* health scores warm up, and then implement with (a) a neutral
cancel observation, (b) a global hedge budget (max N hedges/min), and
(c) GET/bodyless-read gating identical to the proxy guard.
