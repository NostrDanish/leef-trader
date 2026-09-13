# Strategies

Strategies live in `src/lib/leef/bot-engine.ts` (`evaluateBot`).
Entries are sized by the [NetEdgeEngine](./NET_EDGE.md) and then scored by
the common Opportunity engine (`src/lib/leef/opportunity.ts`). Strategies
propose intent; they never skip the shared gate. Auto is the orchestrator
that ranks already-scored opportunities by expected value
(`net × execProb × freshness × inventory × calibration`) — not by headline
percent. Exits are never edge-gated (risk actions must always fire).

## Regime engine + exact-quote gate (Strategy V2 layer)

**Regime engine** (`src/lib/leef/regime.ts`): one deterministic
classification per evaluation from the bot's 30s print series plus the
cross-pool book — `dislocation` (pools disagree ≥ 0.35% — arb territory,
directional entries damped), `trend_up` / `trend_down` (EMA8 vs EMA21
separation measured in units of per-print volatility), `high_vol` /
`low_vol`, `range`, `unknown` (warming up — no vetoes). Every strategy
reads the same verdict:

- **trend_down**: signal buys off, DCA vetoed (never average into a
  downtrend), mean-reversion needs a 3-print hook (falling-knife filter),
  grid damped, spread arb boosted.
- **range**: mean-reversion and grid boosted, signal damped.
- **high_vol**: arb boosted, DCA and growth clips damped.
- **dislocation**: arb boosted most; everything directional damped.
- Regime weights feed Auto's candidate ranking via strategy confidence, so
  the ensemble favors the engine that fits the market. **Vetoes only ever
  suppress entries — exits always fire.**

**Danger score** (`dangerScore` in `regime.ts`): one unified 0–100 defensive
number every strategy shares — book staleness, per-print volatility,
cross-pool disagreement, thin liquidity, and recent execution errors.
Bands: 0–20 normal · 20–40 cautious (0.9× size) · 40–60 reduced (0.8×) ·
60–80 selective (0.5×) · 80+ HOLD (entries only; stop-loss, take-profit,
trailing and manual sells still fire). No strategy may override it.

**Universal exact-quote gate** (`src/lib/leef/exact-gate.ts` +
`verifyExecutableRoute` in the loop): the route graph prices with
constant-product math, but Alcor is a CLMM — the local quote is never the
execution truth. Before any signer is touched, every entry re-runs its own
thesis on the fresh executable venue quote for the exact size:

- **buy** → `exactEntryVerdict`: exact entry execution cost + modeled exit
  vs the strategy's expected gross and `minNetEdgePct`.
- **swap (growth)** → `verifyGrowthExact`: the treasure-growth firewall on
  exact target deltas.
- **swap (tape / next-hop / volume-x)** → `exactSwapVerdict`: exact net %
  vs the decision's floor (profit ≥ 0, tape ≥ −loss budget), including the
  chain-guaranteed min-out worst case.
- **arb** → already exact: `quoteArbPlan` re-quotes both legs through the
  Alcor router and enforces the profit floor on-chain in the memos.

If the exact quote fails the thesis, the trade dies as HOLD. The four
quantities are modeled separately: expected output, guaranteed (min-out)
output, execution input, and the on-chain protected floor.

**Treasure growth** is different: it does not trade a pair. It grows 1–3
named assets. See [below](#treasure-growth--dont-trade-pairs-grow-assets).

## Strategy matrix

| Strategy | Entry logic | Exit logic | Cost awareness | Liquidity awareness | Verdict |
|---|---|---|---|---|---|
| Signal rider | 7-indicator vote (BB/MACD/RSI/EMA/Stoch/VWAP) flips bullish with confidence ≥ `minConfidence` | vote flips sell, TP, SL, trailing | ✅ full cost model via NetEdgeEngine | ✅ impact cap + edge sizing | KEEP (edge-gated since Phase 2b) |
| Mean reversion | RSI ≤ 30 **and** %B ≤ 0.1 (tag of the lower band) | RSI ≥ 62 or %B ≥ 0.9, plus guards | ✅ expected move = 70% of measured distance to midline | ✅ same | KEEP |
| Spread arb | two WAX books diverge ≥ `minEdgePct` + slippage headroom (CP scan) | atomic — same transaction | ✅ exact: Alcor CLMM re-quote, on-chain min-out floor | ✅ router legs carry real depth | KEEP (floor now enforced on the actual memos) |
| Grid stepper | price drops one `gridStepPct` below the anchor | price rises one step above the anchor sell | ✅ expected = 80% of one step vs round-trip costs | ✅ same | KEEP |
| DCA accumulator | every cycle until position cap | TP / SL / trailing | ✅ entries still must clear net edge | ✅ same | KEEP |
| Volume maker | atomic WAX→LEEF→WAX echo whenever round-trip cost ≤ `maxEchoLossPct` | atomic — same transaction | ✅ exact quote + on-chain loss-budget floor | ✅ router legs | KEEP (budget-bounded; not wash trading — see below) |
| Treasure growth | maximize 1–3 target token counts from whatever you hold (direct, multi-hop, cycle) | HOLD unless expected target growth clears the firewall | ✅ fees, impact, value-drop cap, harvest floor | ✅ exec probability + impact cap | KEEP (objective = target units, not USD) |

## Notes on hard thresholds (and why they exist)

- `BOT_WARMUP_POINTS = 34` prints — enough for the 26-period MACD slow EMA
  plus signal line to be defined before the vote is trusted.
- `MIN_LEEF_BACKING = 1,000,000` LEEF (`amm.ts`) — pools thinner than this
  misquote routes and can't absorb even micro clips.
- `maxEchoLossPct = 1.5%` default — two 0.3% fee tiers plus impact typically
  cost 0.6–1.5%; below that the echo would always revert.
- `minNetEdgePct = 0` default — WAX micropayments. A $1e-10 net on a
  dust clip is a win; the engine still refuses negative-EV directional
  entries. Volume is gated by `maxEchoLossPct` (LP-fee budget), not by
  a dollar profit floor.
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

## Treasure growth — don't trade pairs. Grow assets.

`src/lib/leef/growth-engine.ts` (`planGrowthAction`). The user names 1–3
treasures and a mix (e.g. LEEF 60 / WAX 30 / TLM 10) plus a mode:

| Mode | Clip | Acquire drop cap | Harvest floor | Idea |
|---|---|---|---|---|
| Max | ~85% of a holding | 2.4% | 0.35% | Deploy working capital when a strong opportunity appears |
| Balanced (default) | ~55% | 1.2% | 0.75% | Protect a reserve; seek edge, don't chase it |
| Compound | ~22% | 0.85% | 1.1% | Tiny conversions and cycles. Small edges, rebuilt every fill |

**Objective:** weighted target-token growth (target units), haircut by
execution probability, quote freshness and impact. Mix gaps are
**wallet-relative** ("LEEF 70%" = 70% of the whole portfolio), so a wallet
full of USDC shows a huge LEEF gap — that working capital is exactly what
the engine wants to deploy. Underweight treasures score higher.

**Exact-quote gate (graph proposes, venue decides):** the candidate's
growth thesis is re-run on the fresh venue quote for the exact size before
any signer is touched (`verifyGrowthExact` in the loop, via
`verifyExecutableRoute`). If the real output no longer grows the treasure
within the firewall caps, the trade dies as HOLD. The GrowthScore shown in
the UI is display-only — the firewall is the permission layer,
expectedGrowth is the ranking key.

**Constraint (anti-destruction):** never execute just because the token
count goes up. A fair AMM convert into treasure may pay the LP fee
(`acquireDropCapPct`); dumping treasure, harvesting, or thin-book impact
must still clear a tighter value-drop cap, impact cap, exec floor and
minimum expected growth. Harvesting a target (LEEF → … → more LEEF)
requires a cycle gain above the mode's harvest floor — directional risk
is explicit.

**HOLD is a successful decision.** The desk prints a why:

```
HOLD
Best opportunity: WAX → LEEF (convert)
Expected growth units $0.0012
Blocked: execution probability 41% < required 55%
No trade.
```

Execution still uses the existing swap path (fresh Alcor quote, governor,
policy, no rebroadcast). After every fill the market graph is rebuilt.

The engine never promises that the token will grow. It continuously seeks
positive expected target growth and chooses HOLD when the book does not
offer a sufficiently strong opportunity.

## Adaptive cooldown

`adaptiveCooldownSec`: spread/volume re-arm at 0.5× base (atomic round trips
are self-contained), DCA at 2× (slow by design), any strategy at 1.5× after
a losing trade. Hard floor: 10s — matches the Live book pull.
