# Trade Cost Model

`src/lib/leef/cost-model.ts` — the single authoritative economic calculation.
Strategies never compute their own fees/impact; everything flows through here.

## Inputs

- `route` — a `SwapRoute` from `compareAllRoutes` (constant-product quote over
  the tracked pools; `amountOut` is already net of AMM fee and price impact).
- `snap` — the current `LeefSnapshot` (USD mids: `waxUsd`, `leefUsd`, and the
  token universe for other symbols).
- `volPerSec` — realized volatility of the bot's own 30s print series,
  per second (see below).
- `config` — `CostConfig` overrides (defaults in `DEFAULT_COSTS`).

## The cost stack

| Component | Symbol | How it's computed |
|---|---|---|
| Entry execution | `execInPct` | `1 − actualOut / idealOut`, where `idealOut = amountIn × usdIn / usdOut`. Captures AMM fee + price impact **exactly once** (they are already inside `amountOut`; nothing is re-added). |
| Exit execution | `execOutPct` | Same measure on the best reverse route at the expected position size. Entries are judged on the full round trip. If no exit route quotes, the entry cost is mirrored (conservative). |
| Slippage allowance | `slippagePct` | `slippageBufferPct` (default 0.05%) — expected reserve drift between quote and fill. The on-chain min-out guard (`risk.slippage`) is the *hard limit*; this is the *expected* cost. |
| Opportunity decay | `decayPct` | `volPerSec × latencySec × decaySigma × 100` — one sigma of adverse price drift over the expected quote→confirm latency (default 4s). |
| Resource cost | `resourceUsd` | `txCostUsd × 2` (entry + exit). Default $0.002/tx ≈ 0.1 WAX of rented CPU; ≈ 0 for well-staked accounts. |
| Failure cost | `failureUsd` | `failureProb × txCostUsd × 2` — reverted transactions still burn CPU. Default 3%. |

```
totalPct = execInPct + execOutPct + slippagePct + decayPct
fixedUsd = resourceUsd + failureUsd
```

## Volatility measurement

`realizedVolPerSec(series)`: sample standard deviation of per-print returns
over the last 60 prints, divided by √seconds-per-print. Returns 0 until at
least 3 prints exist, so a cold bot charges zero decay rather than inventing
volatility.

## What is deliberately NOT here

- **Double-counted fees.** `route.spotPrice` in the router math is already
  fee-adjusted; the USD-mid comparison above avoids that trap.
- **Magic thresholds.** The model computes costs; the *accept/reject*
  threshold lives in risk config (`minNetEdgePct`), not in the cost model.
- **Chain-specific guesses.** WAX resource cost is a config value, because it
  depends on the account's stake. Document yours if you rent CPU heavily.
