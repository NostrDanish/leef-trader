# Execution routing

Status: production ranking + live Alcor execution. Local search is a
**bounded heuristic**, not a claimed global optimum.

## Pipeline

```
exact size
  → pool graph (contract + symbol)
  → best-first search, up to MAX_ROUTE_HOPS (10)
  → conservative Pareto dominance (amount, hops, used-pool subset)
  → extra hops win ONLY if destination amount is higher
  → 2-book golden-section split; optional 3rd book residual
  → rank by expected destination fill
   → LIVE: Alcor legs requote CLMM; Defibox/Taco use min-out memos
     (see VENUES.md)
```

## Dominance (why the old rule was unsafe)

A state that reaches token X with more intermediate output does **not**
dominate another state at X if it used different pools. The slightly worse
arrival may still own the only good continuation.

We only prune B when some A has ≥ output, ≤ hops, **and** used a subset of
B's pools. Different used-pool sets are never collapsed.

This is **conservative**, not exact. The search also caps expansions
(8 000) and outgoing edges (top quotes ∪ deepest books; all edges if ≤16).
Do not document this as mathematically optimal.

## Branching

Outgoing edges are not “top 8 quotes only.” We take:

- the best immediate quotes, **and**
- the deepest reserve books (downstream liquidity), **and**
- every edge when the node has ≤16 quotable exits.

A first hop that looks mediocre on output can still be expanded if it is
deep. A 9th-best skinny quote into a unique destination can still be
picked via the depth union.

## Splits

Two-book allocation is golden-section on share α. A third book may take a
small residual if that raises combined output. Splits execute only if they
beat the best single path by ≥ 0.3% (extra CPU of extra transfers).

## Live vs local

Local constant-product is **ranking**; the venue quote is execution truth.
Alcor CLMM edges quote CP over **virtual reserves** (`L/√P`, `L·√P` from the
pool's on-chain `liquidity` + `sqrtPriceX64`), which is anchored at the tick
price — exact at the margin and exact for any fill that stays inside the
current tick range. (The previous CP-on-raw-balances was not "conservative
for CLMM", it was wrong: a +56.8%/−36.2% level error measured on pool 217 —
see ALCOR_COMPARATIVE_AUDIT §3.3.) Pools without CLMM state fall back to raw
reserves, and Defibox/Taco always quote raw — their raw reserves ARE the CP
reserves. Live Buy/Sell and bot fills **requote Alcor** immediately before
signing, and the on-chain minOut memo is the hard freshness guard (the
venue caches each router trade for 5 s server-side, so within that window a
re-quote returns the identical cached trade — minOut, not the re-quote, is
the guarantee). Unknown chain status is never retried blindly.

## Terminology

- **direct** = one pool / one swap
- **N-hop** = N swaps (N ≤ 10)
- There is no executable “0-hop” route
