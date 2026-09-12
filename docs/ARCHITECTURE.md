# Architecture

Status: reflects the code as it exists today.

## Layers

```
┌────────────────────────────────────────────────────────────┐
│ UI (src/components/terminal)                                │
│   dashboard · quotes · bot-desk · pools · portfolio ·       │
│   wallet · infra (provider health + endpoint config)        │
│   subscribes via useMarketEngine — never owns a loop        │
└──────────────┬─────────────────────────────────────────────┘
               │ zustand stores (src/store: bot, wallet, portfolio, terminal)
┌──────────────▼─────────────────────────────────────────────┐
│ MARKET ENGINE  (src/lib/market/market-engine.ts) — singleton │
│   block heartbeat · Alcor pulls · swap.alcor on-chain spot  │
│   balance watcher · bot/rebalancer drivers · resume resync  │
│   → event-bus.ts (block/snapshot/pools/balances/resume)     │
│   → route-cache.ts (dependency-aware route invalidation)    │
│   → stables.ts (trusted SYMBOL@CONTRACT stable oracle)      │
├─────────────────────────────────────────────────────────────┤
│ CHAIN PROVIDERS  (src/lib/wax)                              │
│   provider-pool.ts  health-scored RPC + Hyperion pools      │
│                     (failover, cooldown, auto-restore)      │
│   alcor-onchain.ts  swap.alcor pools table → sqrtPriceX64   │
│   endpoints.ts      curated defaults + runtime config       │
├─────────────────────────────────────────────────────────────┤
│ MARKET DATA  (src/lib/leef/snapshot.ts)                     │
│   Alcor REST → full pool list (10 min rediscovery)          │
│   → tracked-pool refresh by id (10–60 s cadence)            │
│   → LEEF USD price hint → attachUsdPrices → LeefSnapshot    │
│   → ranked routes (rank.ts), tape (swaps), universe.ts      │
├─────────────────────────────────────────────────────────────┤
│ STRATEGY ENGINE  (src/lib/leef/bot-engine.ts)               │
│   evaluateBot(): gates → scans → position mgmt → entries    │
│   6 strategies produce Decision objects                     │
├─────────────────────────────────────────────────────────────┤
│ ECONOMIC CORE                                                │
│   cost-model.ts  TradeCostModel — one authoritative cost     │
│   net-edge.ts    NetEdgeEngine — net edge, optimal size,     │
│                  explainable opportunity score               │
├─────────────────────────────────────────────────────────────┤
│ RISK  (bot-engine gates + engine preflight)                  │
│   impact/position/hourly caps, cooldowns (adaptive),         │
│   session goal, max drawdown, staleness gate,                │
│   WAX CPU/NET/RAM resource preflight                         │
├─────────────────────────────────────────────────────────────┤
│ EXECUTION  (src/lib/wallet)                                  │
│   alcor-route.ts  Alcor swapRouter client (exact CLMM)       │
│   policy.ts       transaction policy firewall                │
│   sign.ts         swap / batch / arb / LP action dispatch    │
│         txid = sha256(packed_trx) known BEFORE broadcast    │
│   antelope.ts     custom WIF/PVT_K1 signer (noble K1)        │
│   session.ts      Wharfkit: WAX Cloud Wallet + Anchor        │
│   chain.ts        provider-pool clients, single-submit push  │
│   reconcile.ts    post-trade chain truth                     │
└─────────────────────────────────────────────────────────────┘
```

See [MARKET ENGINE](./MARKET_ENGINE.md) for the engine's design contract
(zero page refresh, provider health scoring, no-duplicate broadcast,
suspension resync) and [WAX](./WAX.md) for chain specifics.

## Data flow per bot cycle

1. The engine's market loop fetches a `LeefSnapshot` (hot pools + prices;
   tape/universe refresh in the background and never block a decision).
2. `botOnSnapshot` (plain function, engine-driven) appends the price print
   and calls `runBotOnce` — single-flight signing plus the capital lock in
   `trade-cycle.ts` ensure one live trade in flight at a time.
3. `evaluateBot` (pure) returns a `Decision`: `buy | sell | arb | hold | stop`.
4. Entries are sized by the NetEdgeEngine; arbs are re-quoted exactly by the
   Alcor router and floor-checked against their on-chain memo min-outs.
5. Live execution passes the policy firewall, signs (session key or external
   wallet), broadcasts exactly once, then reconciles via RPC + Hyperion —
   the recorded fill is the chain's actual transfers, not the quote.
6. Everything lands in the decision journal (`store/bot.ts`), including
   predicted-vs-realized edge per strategy.
7. Between API pulls, the engine's on-chain spot loop patches hot pools from
   `swap.alcor` table rows; meaningful changes re-trigger 2–6 — prices move
   at chain speed, not at API-cadence speed.

## The Nostr shell

The app is built on a Nostr client template: `App.tsx` wires NostrProvider /
NostrSync / login, and `AppRouter` keeps a `/:nip19` route. None of it is on
the trading path; no Nostr key can sign WAX transactions. It is retained for
future notifications/journal-sharing and is safe to ignore for trading.

## Persistence

zustand `persist` middleware, versioned keys (`leef-bot-v1` v4,
`leef-wallet-v2`, `leef-portfolio-v1`). Private keys are **never** persisted —
`secret.ts` is module-scope memory only; `partialize` explicitly excludes
anything sensitive.
