# Strategies

All six strategies live in `src/lib/leef/bot-engine.ts` (`evaluateBot`).
Entries are sized by the [NetEdgeEngine](./NET_EDGE.md) and then scored by
the common Opportunity engine (`src/lib/leef/opportunity.ts`). Strategies
propose intent; they never skip the shared gate. Auto is the orchestrator
that ranks already-scored opportunities by expected value
(`net × execProb × freshness × inventory × calibration`) — not by headline
percent. Exits are never edge-gated (risk actions must always fire).

## Strategy matrix

| Strategy | Entry logic | Exit logic | Cost awareness | Liquidity awareness | Verdict |
|---|---|---|---|---|---|
| Signal rider | 7-indicator vote (BB/MACD/RSI/EMA/Stoch/VWAP) flips bullish with confidence ≥ `minConfidence` | vote flips sell, TP, SL, trailing | ✅ full cost model via NetEdgeEngine | ✅ impact cap + edge sizing | KEEP (edge-gated since Phase 2b) |
| Mean reversion | RSI ≤ 30 **and** %B ≤ 0.1 (tag of the lower band) | RSI ≥ 62 or %B ≥ 0.9, plus guards | ✅ expected move = 70% of measured distance to midline | ✅ same | KEEP |
| Spread arb | two WAX books diverge ≥ `minEdgePct` + slippage headroom (CP scan) | atomic — same transaction | ✅ exact: Alcor CLMM re-quote, on-chain min-out floor | ✅ router legs carry real depth | KEEP (floor now enforced on the actual memos) |
| Grid stepper | price drops one `gridStepPct` below the anchor | price rises one step above the anchor sell | ✅ expected = 80% of one step vs round-trip costs | ✅ same | KEEP |
| DCA accumulator | every cycle until position cap | TP / SL / trailing | ✅ entries still must clear net edge | ✅ same | KEEP |
| Volume maker | atomic WAX→LEEF→WAX echo whenever round-trip cost ≤ `maxEchoLossPct` | atomic — same transaction | ✅ exact quote + on-chain loss-budget floor | ✅ router legs | KEEP (budget-bounded; not wash trading — see below) |

## Notes on hard thresholds (and why they exist)

- `BOT_WARMUP_POINTS = 34` prints — enough for the 26-period MACD slow EMA
  plus signal line to be defined before the vote is trusted.
- `MIN_LEEF_BACKING = 1,000,000` LEEF (`amm.ts`) — pools thinner than this
  misquote routes and can't absorb even micro clips.
- `maxEchoLossPct = 1.5%` default — two 0.3% fee tiers plus impact typically
  cost 0.6–1.5%; below that the echo would always revert.
- `minNetEdgePct = 0.1%` default — the micro-edge floor: WAX transaction
  costs are near zero, so a 0.1% *net* clearance is economically meaningful
  while still refusing trades whose costs eat the thesis.
- `maxQuoteAgeSec = 45s` — the book refreshes every 30s; 45s tolerates
  exactly one missed pull, then fails closed.

## Volume maker is not wash trading

The echo is a real economic trade: it pays the spread and fees out of a
user-configured budget, enforced **on-chain** (the return leg's min-out makes
the transaction revert if the round trip would cost more than the budget).
When a cross-pool spread exists, the echo can be net-profitable. It never
hides its cost: `volumeUsd` and `echoCostUsd` are tracked separately in the
bot stats. Per the project philosophy, volume is never the objective
function — the budget exists so volume, when it happens, is bought at a
known, bounded price.

## Predicted vs realized edge (calibration)

Every closed trade records, per strategy: predicted net edge at entry,
realized edge at exit, P&L, win/loss, and execution latency
(`stats.byStrategy`). After 3+ fills, `calibrationHaircut = clamp(realized/predicted, 0.3, 1.15)`
haircuts that strategy's expected value so a thesis that promised +0.8% and
delivered +0.1% no longer wins the Auto ranking. This is adaptive
calibration, not an LLM in the loop.

## Adaptive cooldown

`adaptiveCooldownSec`: spread/volume re-arm at 0.5× base (atomic round trips
are self-contained), DCA at 2× (slow by design), any strategy at 1.5× after
a losing trade. Hard floor: 10s — matches the Live book pull.
