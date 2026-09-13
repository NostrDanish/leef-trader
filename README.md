# LEEF Trader

A WAX-native trading terminal and automated trading engine for the LEEF
ecosystem, executing on Alcor's concentrated-liquidity AMM. Browser-based,
non-custodial: keys never leave the tab. The site loads **once** — a
persistent market engine (block heartbeat, health-scored RPC failover,
on-chain pool state) keeps prices, routes, balances and strategies updating
continuously with no page refresh and no key re-import.

[![Edit with Shakespeare](https://shakespeare.diy/badge.svg)](https://shakespeare.diy/clone?url=https%3A%2F%2Fgithub.com%2FNostrDanish%2Fleef-trader.git)

## What it does

- **Terminal**: live LEEF pool book (Alcor API pulls + direct `swap.alcor`
  table reads between them), ranked routes, tape of recent fills, pool
  analytics, LP management, token universe.
- **Infrastructure**: a health-scored pool of 8 WAX RPC nodes + 5 Hyperion
  history nodes with automatic failover, cooldown/restore, block-lag
  rejection and runtime endpoint configuration — plus a live infrastructure
  status desk. See [MARKET ENGINE](./docs/MARKET_ENGINE.md).
- **Manual trading**: Buy Now / Sell Now pick the **best executable route for
  that exact size** across Alcor, Defibox, and TacoSwap (direct, multi-hop, or
  split) — paper by default, live when a wallet/session key is connected.
  See [ROUTING](./docs/ROUTING.md) and [VENUES](./docs/VENUES.md).
- **Automated bot**: signal, mean reversion, spread arb, grid, DCA, volume
  maker, plus **Treasure growth** — name 1–3 assets to accumulate; the bot
  maximizes those token counts without destroying portfolio value, and HOLDs
  (with a why) when the book does not offer enough expected growth.
- **Rebalancer**: priority-ladder portfolio sweeps (dust consolidation + drift
  repair) as one atomic WAX transaction.
- **Economic discipline**: every entry is sized and gated by a central cost
  model and net-edge engine — see below.

## The economic core (what makes it a trading system, not a script)

Every bot entry flows through:

```
strategy signal
  → NetEdgeEngine        expected gross move − ALL modeled costs
  → optimal size scan    profit-maximizing size ≤ risk cap (often smaller!)
  → opportunity score    explainable 0–100 (edge × execution × liquidity
                         × confidence × freshness)
  → risk engine          impact cap, position cap, cooldown, hourly cap,
                         staleness gate, WAX CPU/NET/RAM preflight
  → execution policy     transaction policy firewall (allowlisted
                         contracts/actions/tokens/receivers)
  → Alcor CLMM router    fresh exact quote, min-out enforced on-chain
  → sign + broadcast     session key (in-memory) or WCW/Anchor —
                         ONE submission; a timeout locks capital as
                         UNKNOWN with the known txid, never a duplicate
  → reconcile            actual transfers read back from the chain —
                         positions and P&L settle from chain truth
  → calibration          predicted vs realized edge recorded per strategy
```

If no trade clears the required net edge after costs, the bot does nothing.
Doing nothing is a successful decision.

See [`docs/`](./docs/) for the full documentation set — start with
[ARCHITECTURE](./docs/ARCHITECTURE.md),
[MARKET ENGINE](./docs/MARKET_ENGINE.md),
[TRADING ENGINE](./docs/TRADING_ENGINE.md) and [NET EDGE](./docs/NET_EDGE.md).

## Develop

```bash
npm ci          # install (or: npm install)
npm run dev     # Vite dev server
npm test        # typecheck + eslint + vitest + build
npm run build   # production build
```

No environment variables are required — the app is fully client-side and
talks to public WAX RPC / Hyperion / Alcor endpoints. See
[CONFIGURATION](./docs/CONFIGURATION.md) for every runtime knob.

## Security model (read before live trading)

- Session keys (WIF/PVT_K1) live **in memory only** — never persisted, never
  transmitted. Closing or refreshing the tab forgets the key.
- Every transaction passes a **policy firewall** before any signer sees it:
  only allowlisted contracts, actions, token contract+symbol+precision, and
  receiver = your account at `swap.alcor`. Anything else is rejected.
- Atomic arbitrage enforces its **profit floor on-chain**: the sell legs'
  min-outs must sum to at least `stake × (1 + floor)` or nothing is signed.
- Prefer a **dedicated trading permission** with limited funds over your
  main account's owner key. Never import an owner key.

Full details in [SECURITY](./docs/SECURITY.md).

## Honest limitations

- **AI integration: PLANNED.** The "AI bot" name refers to the deterministic
  multi-engine signal blend. No LLM is wired into trading decisions today.
- **Backtester: PLANNED.** Strategy calibration currently learns from live /
  paper results only (predicted-vs-realized edge memory).
- Paper fills use the same route math but do not simulate partial fills,
  competing flow, or confirmation latency.
- The app is a browser tab: automation runs while the tab is open. There is
  no server-side 24/7 daemon (PLANNED as an optional worker; keys would stay
  client-side or in a user-controlled vault — never in frontend env vars).
- The Nostr login/shell is template heritage and not required for trading.

## License

See repository. Trade at your own risk — this software optimizes for positive
expected value under explicit costs and limits; it cannot and does not promise
profit.

---

_Vibed with [Shakespeare](https://shakespeare.diy)_
