# Architecture

Status: reflects the code as it exists today.

## Layers

```
┌────────────────────────────────────────────────────────────┐
│ UI (src/components/terminal)                                │
│   dashboard · quotes · bot-desk · pools · portfolio · wallet│
└──────────────┬─────────────────────────────────────────────┘
               │ zustand stores (src/store: bot, wallet, portfolio, terminal)
┌──────────────▼─────────────────────────────────────────────┐
│ MARKET DATA  (src/lib/leef/snapshot.ts)                     │
│   Alcor REST → full pool list (10 min rediscovery)          │
│   → tracked-pool refresh by id (30 s cadence)               │
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
│ RISK  (bot-engine gates + use-bot-loop preflight)            │
│   impact/position/hourly caps, cooldowns (adaptive),         │
│   session goal, max drawdown, staleness gate,                │
│   WAX CPU/NET/RAM resource preflight                         │
├─────────────────────────────────────────────────────────────┤
│ EXECUTION  (src/lib/wallet)                                  │
│   alcor-route.ts  Alcor swapRouter client (exact CLMM)       │
│   policy.ts       transaction policy firewall                │
│   sign.ts         swap / batch / arb / LP action dispatch    │
│   antelope.ts     custom WIF/PVT_K1 signer (noble K1)        │
│   session.ts      Wharfkit: WAX Cloud Wallet + Anchor        │
│   chain.ts        WAX RPC ×4, Hyperion ×3, resources         │
│   reconcile.ts    post-trade chain truth                     │
└─────────────────────────────────────────────────────────────┘
```

## Data flow per bot cycle

1. `useSnapshot` (react-query, 30 s) fetches a `LeefSnapshot`.
2. `useBotLoop` appends the price print to the series and calls
   `runBotOnce` — a single-flight guard (`executing`) ensures one trade in
   flight at a time.
3. `evaluateBot` (pure) returns a `Decision`: `buy | sell | arb | hold | stop`.
4. Entries are sized by the NetEdgeEngine; arbs are re-quoted exactly by the
   Alcor router and floor-checked against their on-chain memo min-outs.
5. Live execution passes the policy firewall, signs (session key or external
   wallet), broadcasts, then reconciles via Hyperion — the recorded fill is
   the chain's actual transfers, not the quote.
6. Everything lands in the decision journal (`store/bot.ts`), including
   predicted-vs-realized edge per strategy.

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
