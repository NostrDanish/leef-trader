# WAX + Alcor specifics

Everything chain-specific lives in `src/lib/wallet/` and the Alcor client in
`src/lib/wallet/alcor-route.ts` + `src/lib/leef/snapshot.ts`.

## Endpoints

- **WAX RPC** (`chain.ts`): wax.greymass.com, wax.eosrio.io, api.waxsweden.org,
  wax.eosphere.io — tried in order per call. `fetchJson` adds per-host
  concurrency limits (4), 429/503 backoff with jitter, and a CORS-proxy retry
  only for network-level failures (HTTP error responses are real answers and
  are never proxied/duplicated).
- **Hyperion** (history): api.waxsweden.org, wax.eosphere.io, wax.eosusa.io —
  used for the full wallet token scan (`/v2/state/get_tokens`) and transaction
  reconciliation (`/v2/history/get_transaction`).
- **Alcor API v2**: `wax.alcor.exchange/api/v2` — pool list (~11 MB,
  rediscovered every 10 min), per-pool refresh (`/swap/pools/:id`, every 30s
  for tracked pools), recent swaps (`/swap/pools/:id/swaps`), token price
  hint (`/tokens/leef-leefmaincorp`), and the swap router
  (`/swapRouter/getRoute`).

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
  canonical K1 signature, self-verified by public-key recovery, broadcast via
  `/v1/chain/push_transaction`. Byte-compatibility with Wharfkit is
  test-pinned.
- Wallets: Wharfkit SessionKit with Cloud Wallet + Anchor plugins. The wallet
  prompts per transaction (Cloud Wallet whitelisting of the swap transfers
  enables hands-free use).

## Resources

CPU/NET/RAM are fetched with balances (`accountResources`) and gate live
trading: CPU > 95%, NET > 98%, or RAM > 98% used → the bot holds with a named
reason instead of burning failed transactions.

## Precision

WAX = 8 decimals (`eosio.token`), LEEF = 4 (`leefmaincorp`). Asset strings
carry their own precision (`"10.00000000 WAX"`); the policy firewall rejects
any transfer whose string precision doesn't match the verified catalog, so a
metadata mix-up fails closed instead of mis-scaling an amount.
