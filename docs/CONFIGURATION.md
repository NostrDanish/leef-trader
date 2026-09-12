# Configuration

**There are no environment variables.** The app is fully client-side; every
knob is a persisted setting (zustand → localStorage) with a documented
default. Nothing secret is ever stored.

## Bot goals (`store/bot.ts` → `goals`, defaults in `DEFAULT_GOALS`)

| Key | Default | Meaning |
|---|---|---|
| `takeProfitPct` | 6 | Per-position take-profit, %. |
| `stopLossPct` | 4 | Per-position stop-loss, %. |
| `trailingPct` | 3 | Trailing stop arm + giveback, %. |
| `sessionGoalUsd` | 0 (off) | Stop the bot when session realized P&L reaches this USD amount. |
| `maxDrawdownPct` | 0 (off) | Stop the bot when session equity drawdown exceeds this %. |

## Bot risk (`risk`, defaults in `DEFAULT_RISK`)

| Key | Default | Meaning |
|---|---|---|
| `minTradeUsd` | 0.01 | **Minimum** notional per new trade, USD. Converted to quote-token units at the live mark. Not a promise a $0.01 trade is executable. |
| `maxPositionUsd` | 1000 | **Maximum** marked position value, USD. Remaining capacity = cap − current market value. |
| `maxImpactPct` | 3 | Reject trades above this price impact. |
| `cooldownSec` | 60 | Base cooldown; adaptive ×0.5 (arb/echo), ×2 (DCA), ×1.5 (after a loss), floor 15s. |
| `maxTradesHour` | 10 | Hourly trade cap (UI slider 1–120). |
| `slippage` | 0.6 | Min-out guard on swap memos (the hard limit, not the estimate). |
| `minConfidence` | 55 | Signal strategy vote threshold, %. |
| `minEdgePct` | 1.2 | Spread arb: minimum profit, enforced on-chain via memo min-outs. |
| `gridStepPct` | 2.5 | Grid step size. |
| `maxEchoLossPct` | 1.5 | Volume maker: max round-trip cost, enforced on-chain. |
| `minNetEdgePct` | 0.1 | Minimum net edge after ALL modeled costs for any entry. |
| `maxQuoteAgeSec` | 45 | Max book age a decision may act on (30s cadence + one miss). |

## Rebalancer (`store/portfolio.ts` → `settings`, defaults in `DEFAULT_REBALANCE`)

| Key | Default | Meaning |
|---|---|---|
| `intervalSec` | 600 | Seconds between automatic checks (desk slider 60–1800). |
| `minDustUsd` | 1 | Dust below this USD value is left alone. |
| `driftPct` | 15 | Relative drift from target share that triggers repair. |
| `maxLegs` | 3 | Max legs per atomic batch. |
| `maxLegUsdPct` | 25 | Single-leg cap as % of portfolio. |
| `reserveWax` | 2 | WAX kept back for CPU/NET. |
| `slippage` | 0.8 | Router slippage for sweep legs. |
| `maxImpactPct` | 4 | Per-leg impact cap. |
| `ladder` | `waxusdc-eth.token, wax-eosio.token, leef-leefmaincorp` | Priority ladder (Alcor token ids). |

## Cost model (`DEFAULT_COSTS` in `lib/leef/cost-model.ts`)

Not yet exposed in the UI (PLANNED); override programmatically.

| Key | Default | Meaning |
|---|---|---|
| `txCostUsd` | 0.002 | WAX CPU/NET cost per tx, USD (≈0 when staked). |
| `failureProb` | 0.03 | Probability a broadcast reverts (burns the resource cost). |
| `slippageBufferPct` | 0.05 | Expected reserve drift between quote and fill. |
| `latencySec` | 4 | Expected quote→confirm latency (decay input). |
| `decaySigma` | 1 | Sigmas of adverse drift charged over the latency window. |

## Network endpoints

Hardcoded public endpoints with per-host failover — see
[WAX.md](./WAX.md#endpoints). No API keys are required or supported.
