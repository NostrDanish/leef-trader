# Net Edge Engine

`src/lib/leef/net-edge.ts` — sits between "strategy has a signal" and
"capital moves".

## The question

> After ALL realistic costs and risks, is this trade economically better
> than doing nothing?

Not "is the signal bullish". WAX's near-zero transaction costs make
*micro-edges* worth harvesting — but only when the numbers survive the whole
cost stack.

## Net edge

For a candidate entry of size `s` with strategy-anchored expected gross move
`G` (percent):

```
netEdgePct(s) = G − costs.totalPct(s) − costs.fixedUsd / notionalUsd(s) × 100
netProfitUsd(s) = notionalUsd(s) × netEdgePct(s) / 100
```

`costs` comes from the [Trade Cost Model](./TRADE_COST_MODEL.md)
(round-trip execution, slippage allowance, volatility decay, resource +
failure cost).

A candidate **passes** iff `netEdgePct ≥ minNetEdgePct` **and**
`netProfitUsd > 0`.

### Where `G` comes from (per strategy)

| Strategy | Expected gross move `G` |
|---|---|
| Signal rider | `confidence × takeProfitPct` — the vote targets the TP, scaled by agreement |
| Mean reversion | `70% × distance to Bollinger midline` — measured, with a haircut |
| Grid stepper | `80% × gridStepPct` — one step, haircut for exit uncertainty |
| DCA accumulator | `takeProfitPct` — the accumulation thesis target |
| Spread arb / volume | not estimated — the Alcor CLMM router quotes the exact round trip and the floor is enforced on-chain |

## Optimal trade size

`optimizeEntrySize` scans a ladder below the risk cap
(`maxIn × [1, 0.75, 0.5, 0.3, 0.15, 0.08]`):

- gross profit scales ~linearly with size,
- price impact grows with size (constant-product: roughly `s / (R + s)`),
- fixed costs shrink *as a percentage* as size grows,

so `netProfitUsd(s)` is concave and has an interior maximum. The engine
returns the passing candidate with the highest expected net profit — often
much smaller than the user's clip. If nothing passes, it returns `null` and
the bot does nothing. That is a successful decision.

## Opportunity score

`scoreOpportunity` — an explainable 0–100 product of five factors:

```
score = 100 × edge × execution × liquidity × confidence × freshness

edge       = clamp01(netEdgePct / (4 × minNetEdgePct))   # 4× required = perfect
execution  = clamp01(1 − execInPct / maxImpactPct)
liquidity  = clamp01(route TVL / $10,000)                # SCORE_LIQUIDITY_REF_USD
confidence = strategy confidence 0..1
freshness  = clamp01(1 − quoteAge / maxQuoteAge)
```

Every score carries an `explain: string[]` with the actual numbers, so the
journal can say *"edge 0.83% (4.2× required) · execution 0.31% of 3% cap ·
liquidity $4,210 TVL · confidence 80% · quote age 1.8s"* — never just "42".

### Quote age vs the venue's 5 s trade cache

`quoteAge` is measured client-side, but the Alcor swapRouter additionally
caches each computed trade for **5 s server-side** (`CACHE_TTL = 5000`,
verified against alcor-ui). Within that window a re-quote returns the
*identical cached trade*, so re-quoting "to be safe" buys nothing — the
on-chain **minOut memo**, not the re-quote, is the real freshness guarantee
(and every executable route carries one). Read a sub-5 s quote age as "same
venue trade", not "freshly computed venue state".

## Failure behavior

No route / unpriceable token / zero notional → `null`. The bot holds. Fail
closed, always.
