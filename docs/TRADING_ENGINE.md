# Trading Engine

The decision pipeline, as implemented. Expensive work only happens for
opportunities that survive the cheap stages.

## The multi-stage pipeline

```
STAGE 1  cheap market filter      snap.source === "live", priced book,
                                  quote age ≤ maxQuoteAgeSec
STAGE 2  opportunity detection    strategy logic on the cached 30s series
                                  + cached pool book (no network)
STAGE 3  net edge + optimal size  NetEdgeEngine over the SAME cached book —
                                  constant-product math, no network calls
STAGE 4  risk validation          impact/position/hourly caps, cooldown,
                                  drawdown/goal stops
STAGE 5  resource preflight       WAX CPU/NET/RAM (live only)
STAGE 6  fresh exact quote        Alcor CLMM router — only now do we spend
                                  an API call (arb always; swaps at sign time)
STAGE 7  execution policy         transaction policy firewall
STAGE 8  sign + broadcast         session key or external wallet
STAGE 9  confirmation + reconcile Hyperion get_transaction → actual transfers
STAGE 10 journal + calibration    decision log, predicted-vs-realized edge
```

## The decision engine

`evaluateBot(input)` is **pure**: same input → same decision, no I/O. All
network/chain effects live in `use-bot-loop.ts`. That separation is what
makes the bot testable and the desk's dry-run preview possible.

Decision kinds: `buy` (sized entry with edge verdict), `sell` (exit),
`arb` (atomic plan), `hold` (do nothing — a successful outcome), `stop`
(session goal / drawdown reached).

## Opportunity dedup

- The bot is single-flight: one trade in flight, then a cooldown
  (adaptive: 0.5× for atomic arbs/echoes, 2× for DCA, 1.5× after a loss,
  floor 15s).
- The rebalancer defers any leg that would **sell LEEF while the bot holds an
  open LEEF position** — same wallet, same market event, one actor at a time.

## Rebalancer

`src/lib/leef/rebalance.ts` — priority ladder (default:
bridged-USDC → WAX → LEEF). Dust sweep consolidates off-ladder tokens worth
≥ `minDustUsd` into the highest-priority routable ladder token; drift repair
moves value upward when a lower-rank token exceeds its geometric target share
by `driftPct`. Every leg is quoted by the Alcor router with an impact cap;
all legs execute as ONE atomic transaction. Scheduler: `intervalSec`
(default 600s).

## Failure modes (all fail closed)

Router down / unrouted → hold or error log, no trade. Stale book → hold.
Exhausted WAX resources → hold with reason. Policy violation → throw before
signing. Broadcast error → decision log + toast, no state change. Tx failed
on-chain → treated as no-trade. Tx status unknown → estimate kept, never
retried, next wallet sync corrects balances.

## Latency

Every live close records sign→reconcile latency into the strategy's
calibration record (`latencyMsSum`). A full latency breakdown dashboard is
PLANNED; today the number is in the data, not yet in the UI.
