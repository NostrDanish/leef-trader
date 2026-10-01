# Security

## Key handling

- Session keys (WIF `5…` or `PVT_K1_…`) are parsed in `wallet/secret.ts` and
  held in a **module-level variable only**. They are never written to
  localStorage/IndexedDB, never transmitted, never logged, and never included
  in persisted zustand state (`partialize` excludes them). Refreshing or
  closing the tab forgets the key.
- WAX Cloud Wallet / Anchor sessions go through Wharfkit
  (`wallet/session.ts`); the page never sees a key at all — the wallet signs.
- The custom signer (`wallet/antelope.ts`, noble secp256k1) self-verifies
  every signature by recovering the public key before returning it, and is
  pinned byte-for-byte against `@wharfkit/antelope` in
  `antelope.test.ts` (keys, name/asset/transfer/transaction packing, TAPOS,
  signing digest, SIG_K1 recovery).

## Transaction policy firewall

`wallet/policy.ts` — `assertActionPolicy` runs inside `dispatchActions`, the
single funnel for ALL signing paths (session key, WCW, Anchor). An action
list is signed only when every action is one of:

1. a token `transfer` from the signing account **to `swap.alcor`**, whose
   quantity's symbol + contract + precision match the verified token catalog
   (base tokens first — a spoofed `LEEF` on a foreign contract can never
   override `leefmaincorp`), with a memo that is either `deposit` (LP) or a
   well-formed `swapexactin#<pools>#<receiver>#<minOut SYM@contract>#<flags>`
   paying the signing account; or
2. `addliquid` / `subliquid` / `collect` on `swap.alcor` owned by — and paying
   — the signing account.

Anything else throws before a signer is invoked. A UI or strategy bug cannot
become an arbitrary on-chain action.

## Token identity

A token is `contract + symbol + precision`. `isLeefToken` accepts only
`LEEF@leefmaincorp`; `isWaxToken` only `WAX@eosio.token`. Anything else is an
unknown token: it does not feed pricing, routing, arb scans, or signing.

## Live execution invariants

- Live swaps require a fresh route from Alcor's CLMM router. There is **no
  fallback to local estimates** for real money; router down = no trade.
- Atomic arbs require router legs for both sides, and the sell legs' on-chain
  min-outs must provably sum to `stake × (1 + floor)` before signing.
- Unknown transaction status after broadcast is never retried blindly; the
  chain is reconciled first (double-spend protection).

## Recommended account setup

Use a **dedicated bot account** holding only the funds you are willing to
risk, and a **dedicated `trade` permission** on it, linked (`linkauth`) only to
the actions the bot needs.

What the app enforces:

- A session key that controls **`owner`** is refused at import, even if the
  same key is also on `active`/a custom permission.
- Key import resolves **all** permissions the key satisfies on its own
  (`choosePermission` in `src/lib/wallet/chain.ts`): exactly one custom
  permission → used; several custom permissions → refused (ambiguous);
  `active` only → allowed with a warning.
- Every signer path (session key and Cloud Wallet/Anchor) refuses to sign
  with `owner` or without an explicit permission (`assertSigningPermission`
  in `policy.ts`) — there is no silent `active` default anymore.

### Creating a `trade` permission (run once, from the account's `active`)

Use Anchor or a block explorer's "push transaction" page. Replace
`yourbotacct1` and the public key. The app never sends these actions itself.

```json
{
  "actions": [
    { "account": "eosio", "name": "updateauth",
      "authorization": [{ "actor": "yourbotacct1", "permission": "active" }],
      "data": { "account": "yourbotacct1", "permission": "trade", "parent": "active",
                "auth": { "threshold": 1,
                          "keys": [{ "key": "PUB_K1_REPLACE_WITH_TRADE_PUBLIC_KEY", "weight": 1 }],
                          "accounts": [], "waits": [] } } },
    { "account": "eosio", "name": "linkauth",
      "authorization": [{ "actor": "yourbotacct1", "permission": "active" }],
      "data": { "account": "yourbotacct1", "code": "eosio.token", "type": "transfer", "requirement": "trade" } },
    { "account": "eosio", "name": "linkauth",
      "authorization": [{ "actor": "yourbotacct1", "permission": "active" }],
      "data": { "account": "yourbotacct1", "code": "leefmaincorp", "type": "transfer", "requirement": "trade" } },
    { "account": "eosio", "name": "linkauth",
      "authorization": [{ "actor": "yourbotacct1", "permission": "active" }],
      "data": { "account": "yourbotacct1", "code": "swap.alcor", "type": "addliquid", "requirement": "trade" } },
    { "account": "eosio", "name": "linkauth",
      "authorization": [{ "actor": "yourbotacct1", "permission": "active" }],
      "data": { "account": "yourbotacct1", "code": "swap.alcor", "type": "subliquid", "requirement": "trade" } },
    { "account": "eosio", "name": "linkauth",
      "authorization": [{ "actor": "yourbotacct1", "permission": "active" }],
      "data": { "account": "yourbotacct1", "code": "swap.alcor", "type": "collect", "requirement": "trade" } }
  ]
}
```

Optional extra links: `<token contract>::transfer` for every other token the
bot may trade (e.g. `eth.token` for WAXUSDC), and `eosio::delegatebw` only if
you use the "stake CPU" button. The platform fee uses the same token
`transfer` actions, so it needs no extra link. Undo with `eosio::unlinkauth` /
`eosio::deleteauth`.

**Caveat:** `linkauth` limits *which actions* a key can sign, **not the
recipient** — a leaked `trade` key can still transfer linked tokens anywhere.
The small float on a dedicated account is the real cap. Cloud Wallet always
signs with its own permission; Anchor lets you pick one.

## Web security

- The app ships a restrictive CSP (`index.html`): `script-src 'self'`, no
  inline scripts, no eval. Do not relax it.
- All market/chain data comes from public endpoints over HTTPS; JSON is
  parsed, never rendered as HTML. No `dangerouslySetInnerHTML` anywhere.
- Nostr keys (template shell) are separate from WAX keys and can never sign
  WAX transactions.

## What we explicitly do NOT do

- No backend holds keys. There is no server component.
- No telemetry/analytics contains wallet or trade data.
- No AI provider receives key material (AI trading integration is PLANNED and
  will be advisory-only: it will never sign or bypass the risk/policy layer).
