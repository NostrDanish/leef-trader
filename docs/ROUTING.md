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
(8 000) and outgoing edges (top quotes ∪ deepest books; all edges if ≤16).
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

Local constant-product on published reserves is **ranking**. Live Buy/Sell
and bot fills **requote Alcor** immediately before signing. Unknown chain
status is never retried blindly.

## Terminology

- **direct** = one pool / one swap
- **N-hop** = N swaps (N ≤ 10)
- There is no executable “0-hop” route
