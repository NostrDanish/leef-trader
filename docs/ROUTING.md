# Execution routing

Status: production. Local graph search ranks candidates; live fills still
requote through Alcor's CLMM router immediately before signing.

## What changed

Buy Now / Sell Now / bot entries go through `src/lib/leef/route-optimizer.ts`:

```
exact size
  → pool graph (contract+symbol identity)
  → best-first search, up to MAX_ROUTE_HOPS (10), dominance pruning
  → extra hops win ONLY if destination amount is higher (no hop haircut)
  → two-book split via golden-section allocation if ≥ 0.3% better than single
  → rank by expected destination fill
```

Local quotes are constant-product on published reserves (conservative vs
Alcor CLMM). Live execution still asks Alcor for a fresh route for that exact
size (`maxHops` matches the local plan, up to 10). The UI says **best
executable route based on the latest quote** — not "guaranteed best".

## Buy Now / Sell Now

Same optimizer, different direction:

- Buy: maximise destination token received for this exact input.
- Sell: maximise destination token received for this exact input.

A book that is best for 1 WAX is not assumed best for 80 WAX. Splits are
executed as one atomic batch (live) or sequential paper fills.

## Token identity

LEEF enters the graph only as `LEEF@leefmaincorp`. WAX only as
`WAX@eosio.token`. Auxiliary hops with spoofed symbols are dropped.

## Strategies vs the router

Strategies emit a thesis (want LEEF / want WAX / want an atomic arb).
They do **not** pick a pool id. The router picks the path for the sized clip.
The net-edge engine still decides whether the clip is worth doing.
