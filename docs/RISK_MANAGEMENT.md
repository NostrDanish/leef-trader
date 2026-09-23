# Risk Management

Risk is enforced in two places: the pure decision engine (`evaluateBot`) and
the execution loop (`use-bot-loop.ts`). Both fail closed.

## Decision-time gates (every cycle, before any entry/exit)

| Gate | Config | Default |
|---|---|---|
| Bot running | — | stopped |
| Book must be live Alcor data | — | fallback book = hold |
| Book freshness | `risk.maxQuoteAgeSec` | 45s (one missed 30s pull tolerated) |
| Session profit goal → stop | `goals.sessionGoalUsd` | 0 (off) |
| Max drawdown → stop | `goals.maxDrawdownPct` | 0 (off) |
| Cooldown | `risk.cooldownSec` (adaptive ×0.5–×1.5, floor 10s) | 15s |
| Hourly trade cap | `risk.maxTradesHour` | 120 |
| Position cap | `risk.maxPositionUsd` | $1,000 marked value |
| Entry impact cap | `risk.maxImpactPct` | 3% |
| Min confidence (signal) | `risk.minConfidence` | 55% |
| Min arb edge (on-chain floor) | `risk.minEdgePct` | 0.3% |
| Min NET edge after all costs | `risk.minNetEdgePct` | 0.1% (WAX micro-edge: dust net wins count, but the floor is not zero) |
| Volume echo loss budget (on-chain) | `risk.maxEchoLossPct` | 1.5% |

These are the shipped defaults. The desk can tighten every one of them —
the values above are the floor the engine enforces, not a claim that looser
is safer.

## Position guards

- **Stop-loss** `goals.stopLossPct` (default 4%) — fires on book price vs entry.
- **Take-profit** `goals.takeProfitPct` (default 6%).
- **Trailing stop** `goals.trailingPct` (default 3%) — arms after the position
  has seen +trailingPct, fires on that much giveback from the high-water mark.
- Exits are **never** blocked by the edge engine. Selling out of risk is
  always allowed.

## Execution-time guards

1. **WAX resource preflight** — refuse to sign when CPU > 95%, NET > 98% or
   RAM > 98% used (`waxResourceBlock`). The hold reason names the resource.
2. **Policy firewall** (`wallet/policy.ts`) — every action list is validated
   before a signer sees it: allowlisted contracts (`swap.alcor` + verified
   token contracts), transfer receiver must be `swap.alcor`, swap memos must
   pay the signing account, token contract+precision must match the catalog.
3. **Arb floor** — the sell legs' on-chain min-outs must sum to at least
   `stake × (1 + floor)`, verified on the actual memos twice (loop + signer).
4. **Min-out guards** — every swap memo carries `minReceived` from the
   configured slippage; if the chain can't deliver, the transaction reverts
   and nothing moves (atomic multi-leg txs revert as a whole).

## Reconciliation

After broadcast, the loop fetches the transaction from Hyperion and reads the
**actual** transfers. `confirmed` → positions/P&L use chain truth;
`failed` → treated as no-trade; `unknown` → **never blind-retried** (the tx
may still land — the next wallet sync corrects balances).

## Emergency stop

The header shows a red **Stop all** button whenever the bot or rebalancer is
running. It halts both engines immediately, leaves positions open, and
requires a deliberate manual restart. The session key stays in memory until
forgotten on the wallet desk.

## Paper / live isolation

A position opened in one mode cannot be managed in the other (a live position
needs the key re-imported; a paper position must be cleared first). Paper and
live balances are separate maps in the wallet store.

## Known limits (honest list)

- The bot runs while the browser tab runs. Closing the tab stops trading;
  open positions persist on-chain but unmanaged. A 24/7 worker is PLANNED.
- Drawdown/goal guards evaluate on the current book's USD marks, not on
  settled chain balances between cycles.
- There is no global daily-loss budget yet (PLANNED); per-position stops and
  the session drawdown cap are the current backstops.
