# Liquidity venues

Status: Alcor is production (CLMM router). Defibox, TacoSwap **and
NeftyBlocks** are **on-chain CP adapters** plugged into the same route
graph — the Nefty venue is live (verified on-chain 2026-09-23; persisted
`neftyVenue` kill-switch, default ON). Ranking quotes are APPROXIMATE;
live Alcor legs remain EXACT.

## Alcor token registry

The venue's own verification layer (`/api/v2/tokens`, one bulk call, cached
30 min): `score` (0–99), `is_trusted`, `is_scam`, `safe_usd_price`. The
universe annotates tokens with the venue score and the pickers show it.
**`is_scam` is fail-closed** — scam-flagged tokens are dropped from both
the universe and the route graph, never priced, routed, or suggested.

## Depth discipline

No oversized position through an undersized pool. The router splits across
books when that pays; if the best route still exceeds the risk impact cap,
the trade is skipped ("too big for the book — already split-optimized").
Manual swaps have a hard 10% impact line.

## Supported venues

| Venue | Contract | Discovery | Quote | Live execution |
|---|---|---|---|---|
| Alcor | `swap.alcor` | HTTP API v2 | Local CP for rank; **swapRouter** before sign | EXACT |
| Defibox WAX | `swap.box` | `get_table_rows` table `pairs` | CP, fee 30 bps (trade 20 + protocol 10) | APPROXIMATE min-out memo `swap,<units>,<pair_id>` |
| TacoSwap | `swap.taco` | tables `pairs` then `pools` | CP, 30 bps unstaked | APPROXIMATE memo `<min> SYM@contract` |

No venue is preferred. The graph asks only: given this size, how much
destination token lands after fees and impact.

## Identity

Pool ids are namespaced so they never collide:

- Alcor: native id
- Defibox: `1_000_000 + pair_id`
- Taco: `2_000_000 + pair_id`
- Nefty: `4_000_000_000 + fnv1a32(pair_code)` — the on-chain key is the
  symbol_code string (e.g. `USDANO`), not a number, so the namespaced id is a
  deterministic 32-bit FNV-1a hash of the code. A hash collision keeps the
  first code and skips the second (logged). The code itself rides on the
  discovered pool (`pairCode`) for fresh-row lookups and memos.

LEEF must be `leefmaincorp`. WAX must be `eosio.token`. Spoofed books never
enter the graph.

## Execution

- All-Alcor routes still requote Alcor CLMM immediately before signing.
- Defibox/Taco/Nefty legs transfer into that venue with a min-out memo.
- Mixed hops are sequential transfers in **one atomic transaction**.
- Policy firewall allowlists `swap.alcor`, `swap.box`, `swap.taco`,
  `swap.nefty` only.
- Dust-safe min-outs (waxterminal `roundingSafeMin` lesson): when the
  expected output is below ~1000 raw units, the memo asks for exactly 1 raw
  unit instead of a slippage-adjusted value the pool's tick rounding cannot
  honor (live reverts: "Received lower than minTokenOut: 30, poolId: 7801").
  Dust trades accept any non-zero execution rather than reverting — gated by
  size, so sandwich exposure is bounded to sub-dust value. The C1 firewall
  floor consumes the same computed ask (`dustSafeMinOut`), so the memo, the
  verified quote and the floor never disagree.

## NeftyBlocks (reverse-engineered — verified live 2026-09-23)

- **Contract**: `swap.nefty`. Swaps are token transfers to it.
- **Tables**: `pairs` (primary key = symbol_code `code`, e.g. `USDANO`;
  `active` flag; `reserve0`/`reserve1` are `extended_asset`), `configs`
  singleton (`fee.protocol` = 10 bp skimmed inline to `sfees.nefty`,
  `fee.trade` = 20 bp → 30 bp total, cross-checked against executed
  `logswap` traces).
- **Memo**: `swap:<CODE>,min:<units>` where `units` is an INTEGER count of
  raw output-token units (trace proof: `min:137` passed on a 19.82-token
  output). WaxOnEdge omits `,min:` — a zero floor our policy firewall
  rejects; every Nefty leg we sign carries a real computed min-out ≥ 1 unit.
- **Quote**: constant-product over raw reserves, verified against an executed
  fill to 0.11% (conservative: the contract floors the fee at input
  precision, so it charges slightly less than 30 bp on small inputs).
- **Discovery**: `next_key` paging over `pairs` (code-keyed — the numeric
  sharded sweep does not apply), 756 pairs live, TVL/dust-filtered like the
  other venues. Fail CLOSED on schema surprises: malformed rows are logged
  and skipped, a table-level failure returns an empty book — never a throw
  into the engine loop.
- **Kill-switch**: persisted `neftyVenue` setting (default ON,
  `setNeftyVenue(false)` pulls the venue out of discovery without a
  redeploy).
- **Limits**: no public router/API (waxterminal/Alcor don't cover it;
  WaxOnEdge's backend is closed); quotes are fresh-model, drift-checked ±8%
  at verify time; 7-char codes are fully supported via hash ids.

## Limitations

- Taco table layout is best-effort (`pairs` then `pools`). If the ABI
  differs, discovery returns empty and the graph stays Alcor-only.
- Defibox/Taco have no public CLMM router; live fills use CP min-out.
- Cross-venue hops are not globally optimal; search remains a bounded
  heuristic (see ROUTING.md).
