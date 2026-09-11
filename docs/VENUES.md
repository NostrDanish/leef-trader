# Liquidity venues

Status: Alcor is production (CLMM router). Defibox and TacoSwap are
**on-chain CP adapters** plugged into the same route graph. Ranking quotes
are APPROXIMATE; live Alcor legs remain EXACT.

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

LEEF must be `leefmaincorp`. WAX must be `eosio.token`. Spoofed books never
enter the graph.

## Execution

- All-Alcor routes still requote Alcor CLMM immediately before signing.
- Defibox/Taco legs transfer into that venue with a min-out memo.
- Mixed hops are sequential transfers in **one atomic transaction**.
- Policy firewall allowlists `swap.alcor`, `swap.box`, `swap.taco` only.

## Limitations

- Taco table layout is best-effort (`pairs` then `pools`). If the ABI
  differs, discovery returns empty and the graph stays Alcor-only.
- Defibox/Taco have no public CLMM router; live fills use CP min-out.
- Cross-venue hops are not globally optimal; search remains a bounded
  heuristic (see ROUTING.md).
