# Platform Fee

**0.001% of every successful trade's guaranteed output to `smart.ass`.**

```
trade (any pair, any venue, any strategy)
  → exact gate (fee-aware)
  → sign (one atomic transaction: swap actions + ONE fee transfer)
  → broadcast
  → confirm → fee collected
  → revert → the fee action reverts with it — failed trades never pay
```

## The constants (the only source)

`src/lib/leef/platform-fee.ts`:

```ts
PLATFORM_FEE_RATE    = 0.00001   // 0.001%
PLATFORM_FEE_BPS     = 0.1
PLATFORM_FEE_ACCOUNT = "smart.ass"
PLATFORM_FEE_MEMO    = "leef-trader platform fee (0.001%)"
```

Not configurable by users, AI, learning, routes, venues, URLs, or API
responses. The policy firewall checks the recipient against the compile-time
constant — a quote can never redirect the fee.

## Mechanics

- **Denominated in the output token**, computed from the GUARANTEED output
  (the on-chain min-out), never the optimistic quote. `100,000 LEEF → 1 LEEF`;
  `100 WAX → 0.001 WAX`.
- **One transfer action appended to the same atomic transaction.** No second
  transaction, no extra signature, and atomicity makes "failed tx pays no
  fee" structural. UNKNOWN transactions record no collected fee until
  reconciliation proves the transfer (journal `platformFeeCollected` is set
  only on chain-confirmed executions).
- **Precision-floored**: fee = floor(amount × rate, token decimals). Below
  one unit the action is skipped — the fee never rounds UP past 0.001%.
- **Exactly once per logical trade**: never per hop, never per split slice
  (a split is one trade — fee on the summed guaranteed output). Cycles charge
  once on the final output. Rebalance sweeps charge once per swept conversion
  (each leg is its own conversion) — those fee actions count toward the
  per-tx CPU chunk cap.

## Economics integration (counted exactly once)

- `cost-model.ts`: `platformFeePct` (0.001%) joins `totalPct` — twice on a
  round trip (entry + exit).
- `exact-gate.ts`: one-shot verdicts subtract the fee from both the expected
  and the guaranteed side; entries carry it through the round-trip model.
- The arb floor is enforced **net of fee**: sell legs' min-outs must cover
  stake + fee + floor before anything is signed.
- Paper fills charge the same fee — paper P&L matches live economics.

## Coverage (every path reaches the same layer)

| Path | Fee point | Once |
|---|---|---|
| Manual swap / pinned route / cycle | `signAndPushSwap` (guaranteedOut) | ✅ |
| Bot buy / sell / swap (all strategies) | `signAndPushSwap` | ✅ |
| Spread arb / volume echo | `signAndPushArb` (sell min-out sum, floor net-of-fee) | ✅ |
| Manual split | one fee leg on summed guaranteed out | ✅ |
| Rebalancer sweep chunk | per swept conversion, CPU-counted | ✅ |
| LP add / stake | not trades — no fee | — |

## Security

- `policy.ts` pins: recipient = `PLATFORM_FEE_ACCOUNT` constant, canonical
  memo, verified token identity + precision, amount ≤ caller-vouched bound
  (computed by `platformFeeOn`, never from venue data).
- `ai-boundary.test.ts` covers `platform-fee.ts` — no AI reach, ever.
- Tests: `platform-fee.test.ts` (math, precision, dust, never-over-rate,
  firewall allow/reject paths).
