# WAX + Alcor specifics

Everything chain-specific lives in `src/lib/wax/` and `src/lib/wallet/`, the
Alcor client in `src/lib/wallet/alcor-route.ts` + `src/lib/leef/snapshot.ts`.
Provider behavior is documented in depth in
[MARKET ENGINE](./MARKET_ENGINE.md).

## Endpoints

All chain access flows through two health-scored provider pools
(`src/lib/wax/provider-pool.ts`) fed by `src/lib/wax/endpoints.ts`:

- **WAX RPC pool** (chain API): wax.greymass.com, wax.eosrio.io,
  api.waxsweden.org, wax.eosphere.io, wax.eosusa.io, wax.cryptolions.io,
  wax.blokcrafters.io, hyperion.wax.eosdetroit.io — **not** tried in blind
  order. Each call goes to the healthiest node
  (`score = success × freshness(block lag) × latency`); failures fail over
  to the next-best, repeated failures cool the node out (20 s → 5 min) and a
  background probe restores it automatically. Nodes > 6 blocks behind the
  network head are never used to broadcast transactions no matter how fast
  they are, and a wrong `chain_id` disqualifies a node permanently.
  The list is editable at runtime (Infrastructure desk → Endpoints,
  localStorage `leef-wax-endpoints`) — a self-hosted WAX node can be added
  without a rebuild.
- **Hyperion pool** (history): wax.eosrio.io, api.waxsweden.org,
  wax.eosphere.io, wax.eosusa.io, wax.cryptolions.io — used for the full
  wallet token scan (`/v2/state/get_tokens`) and transaction reconciliation
  (`/v2/history/get_transaction`). History failure never blocks trading;
  only reconciliation waits.
- **Alcor API v2**: `wax.alcor.exchange/api/v2` — pool list (~11 MB,
  rediscovered every 10 min), per-pool refresh (`/swap/pools/:id`, 10–60 s
  for tracked pools), recent swaps (`/swap/pools/:id/swaps`), token price
  hint (`/tokens/leef-leefmaincorp`), and the swap router
  (`/swapRouter/getRoute`).
- **On-chain pool state** (`src/lib/wax/alcor-onchain.ts`): the engine also
  reads `swap.alcor`'s `pools` table directly from WAX RPC — the same source
  Alcor's own v2 SDK uses (`currSlot.sqrtPriceX64` / `currSlot.tick`) — so
  prices move at chain speed between API pulls. Chain truth, not website
  truth.

`fetchJson` adds per-host concurrency limits (4 with one HIGH-reserved slot),
429/503 backoff with jitter, and a CORS-proxy retry only for network-level
failures (HTTP error responses are real answers and are never
proxied/duplicated).

## How a swap executes on Alcor's AMM

Alcor's concentrated-liquidity contract (`swap.alcor`) executes swaps as
plain token **transfers into it**, with the route encoded in the memo:

```
swapexactin#<poolIds_csv>#<receiver>#<minOutAmount SYMBOL@contract>#<flags>
```

The contract enforces `minOut` on-chain: if the fill would deliver less, the
transaction reverts and no funds move. Multi-leg routes arrive **split** from
the router (each split = its own transfer); several transfers inside one
transaction execute sequentially and atomically — which is what makes the
two-leg arbitrage and the volume echo revert-safe.

Atomic arb shape (one transaction):

1. `eosio.token.transfer`: WAX → swap.alcor (buy legs, memo min-out in LEEF)
2. `leefmaincorp.transfer`: LEEF → swap.alcor (sell legs, memo min-out in WAX)

Leg 2 spends what leg 1 bought. If any min-out fails, everything reverts.

## CLMM vs the local book

The local routing/scanning math is constant-product over pool reserves —
deliberately **conservative** for concentrated-liquidity pools and only used
for ranking, scanning, and paper fills. Every live execution re-quotes
through Alcor's router (exact tick math) immediately before signing. The
local model never authorizes a live trade.

## Signing stack

- Session key: custom signer (`antelope.ts`) — WIF/PVT_K1 parse, name/asset
  packing, TAPOS header from `get_info` (last irreversible block, 90s
  expiration), `sha256(chain_id ‖ packed_tx ‖ 32×0)` digest, deterministic
  canonical K1 signature, self-verified by public-key recovery. The
  transaction id (`sha256(packed_trx)`) is computed **before** broadcast, so
  a network timeout during `/v1/chain/push_transaction` immediately locks
  capital as UNKNOWN with a known txid for reconciliation — the signed
  payload is never blindly re-broadcast (an HTTP timeout does not mean the
  transaction wasn't accepted). There is exactly one submission attempt;
  every uncertain outcome is resolved by reconciliation, not a retry.
- Wallets: Wharfkit SessionKit with Cloud Wallet + Anchor plugins. The wallet
  prompts per transaction (Cloud Wallet whitelisting of the swap transfers
  enables hands-free use).

The signing session is independent of market data: market/balance/route
refreshes never re-create or re-import the signer. Raw keys are memory-only;
a genuine browser reload requires re-import by design.

## Resources

CPU/NET/RAM are fetched with balances (`accountResources`) and gate live
trading: CPU > 95%, NET > 98%, or RAM > 98% used → the bot holds with a named
reason instead of burning failed transactions.

## Precision

WAX = 8 decimals (`eosio.token`), LEEF = 4 (`leefmaincorp`). Asset strings
carry their own precision (`"10.00000000 WAX"`); the policy firewall rejects
any transfer whose string precision doesn't match the verified catalog, so a
metadata mix-up fails closed instead of mis-scaling an amount.

## Token identity & stablecoins

Canonical identity is **SYMBOL@CONTRACT** — never a symbol alone. Two
different contracts can both issue a token called `WAXUSDC`; they are two
different assets everywhere prices, balances, routes, risk or the policy
catalog are concerned (`src/lib/market/stables.ts`).

Trusted WAX stable registry (symbol + verified issuing contract):
`WAXUSDC@eth.token`, `WAXUSDT@eth.token`, `USDT@usdt.alcor`,
`PARAUSD@parareserves`. Only these get stable treatment; their USD prices
flow through the oracle states PEGGED / MINOR_DEVIATION / STRESSED /
DEPEGGED / UNKNOWN (liquidity-gated). A depegged stable is priced honestly —
never forced to $1 — and a symbol clone on a foreign contract is never given
the $1 prior at all: it is priced by its own pools like any volatile token.
This is what makes 53 WAXUSDC display as ≈ $53 instead of a clone-pool price.
