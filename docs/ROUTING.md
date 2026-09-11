# Execution routing

Status: production. Local graph search ranks candidates; live fills still
requote through Alcor's CLMM router immediately before signing.

## What changed

`compareAllRoutes` used to enumerate a handful of hardcoded 1–2 hop patterns
and rank by **gross `amountOut`**. Buy Now / Sell Now / bot entries now go
through `src/lib/leef/route-optimizer.ts`:

```
exact size
  → pool graph (contract+symbol identity)
  → paths up to 3 hops, no cycles / no reused pools
  → extra hops only if they beat a shorter path by ≥ 0.4% net output
  → optional split across parallel books if ≥ 0.3% better than the best single
  → rank by expected fill after hop penalty
```

The UI may say **best executable route based on the latest quote** — not
"guaranteed best". Live execution still asks Alcor for a fresh route for that
exact size (`maxHops` matches the local plan, default 3).

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
