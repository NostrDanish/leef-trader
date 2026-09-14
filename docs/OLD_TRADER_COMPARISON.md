# Old Trader — forensic comparison & recovery report

**Date:** 2026-09-14 · **Current HEAD:** `1c0babb` · **Old source:** `multi-asset-ai-trading-game.zip` (~2,400 lines, AI Studio game)

Method: read every old file; compare behavior, not filenames. The old trader is a
reference/behavior oracle — the current architecture stays authoritative.

---

## Executive summary

The old trader is a single-file-per-service AI Studio game: one hardcoded RPC
(`wax.greymass.com`), no failover, no reconciliation (it never waits for
confirmation — fire-and-forget), no paper mode, no policy firewall, no min-out
verification beyond the router's slippage parameter, no multi-venue routing, no
danger/regime concept. The current trader is ahead on essentially every axis.

Two genuine capabilities were lost in the rebuild and are now recovered:

1. **CPU staking** — the old trader could `delegatebw` in-app. The current one
   *shows* CPU% and *blocks* trades at 95%… with no remedy. Now recovered
   through the policy firewall.
2. **Screen wake lock while trading** — the old trader prevented screen sleep
   during an active session. The current engine resyncs perfectly on wake, but
   never *prevented* the sleep. Now held while the bot runs.

Everything else was either already superseded or rejected for cause (below).

## Function-by-function diff (trading core)

| Capability | Old | Current | Verdict |
|---|---|---|---|
| Swap quote | Alcor `swapRouter/getRoute`, maxHops=3 | Same router + local CP graph + venue verification | KEEP CURRENT |
| Min-out protection | Router slippage param only | Fresh quote + per-leg min-out + on-chain floor | KEEP CURRENT |
| Confirmation | None (fire-and-forget) | waitForTransaction + reconcile + UNKNOWN lock | KEEP CURRENT |
| RPC | Single endpoint | Health-scored pool of 8 + failover | KEEP CURRENT |
| Paper mode | None | Full unsigned path | KEEP CURRENT |
| Policy firewall | None | Every action validated before sign | KEEP CURRENT |
| Multi-venue | Alcor only | Alcor + Defibox + Taco | KEEP CURRENT |
| Strategies | RSI/MA/BB/MACD/scalping per pair | 7-engine vote + meanrev + grid + arb + growth + regime | KEEP CURRENT |
| Rebalance | Sequential swaps, re-fetch between | One atomic WAX tx | KEEP CURRENT |
| Cooldown | Per-pair fixed 9s | Global adaptive (0.5×/1.5×/2×) | KEEP CURRENT |
| Impact guard | Abort >5%, haircut 1–5% | maxImpactPct cap + impact in exec probability | KEEP CURRENT |
| Profit preference | `profitPreference` weight | Growth Brain (1–3 targets, modes) | KEEP CURRENT (superseded) |
| **CPU staking** | `delegatebw` panel | **was missing** | **RECOVERED** |
| **Wake lock** | `navigator.wakeLock` | **was missing** | **RECOVERED** |
| Background polling while hidden | 15s interval | Deliberate resync-on-wake instead | KEEP CURRENT (safer — a throttled tab trades blind) |
| Wombat wallet | Supported | Not supported | REJECT (dead wallet on WAX) |
| TransactPluginAutoCorrect | Global | None — manual packing + policy | REJECT (auto-modifying txs is the opposite of the firewall) |
| Achievements/sounds/ads | Yes | No | REJECT (game chrome) |
| Cost-basis per-asset P&L | `netUsdInvested` | Session P&L + target-unit P&L | KEEP CURRENT (different model, fine) |
| resilientFetch (3×, exp backoff + jitter, 5xx-only) | Yes | fetchJson queue + provider pool | KEEP CURRENT (pool subsumes it) |

## Lost WAX knowledge found

- `delegatebw` on `eosio` with `stake_cpu_quantity` at 8dp, `transfer: false` —
  the in-app remedy for the 95% CPU trade-pause. Recovered with policy rules:
  self-stake only, WAX only, 8dp only, `transfer=true` rejected (it would give
  the stake away).
- WakeLock releases automatically when the tab hides → must re-request on
  `visibilitychange → visible` while wanted. Implemented exactly that.
- Old Alcor route call used `maxHops=3` and `slippage=0.5%` — current routing
  already supersedes (size-specific graph + fresh router quote).

## What was deliberately NOT ported

- Background trading from hidden tabs (old polled at 15s while hidden). The
  current engine instead marks time and resyncs from chain truth on wake. A
  throttled browser tab trading blind is a reliability trap, not a feature.
- `TransactPluginAutoCorrect` — silently rewrites transactions. Incompatible
  with "the signer never sees anything but the intended action".
- The whole game layer (achievements, XP, sounds, ad display).

## Changes shipped in this recovery

- `src/lib/wallet/antelope.ts` — `packDelegateBw` (eosio.system ABI order).
- `src/lib/wallet/policy.ts` — `eosio::delegatebw` allowlist rule (self-stake,
  WAX 8dp, never transfer=true) + regression tests.
- `src/lib/wallet/sign.ts` — `signAndPushStakeCpu` through `dispatchActions`
  (same policy → signer path as trades).
- `src/components/terminal/wallet-desk.tsx` — stake control appears when live
  CPU > 60%.
- `src/lib/market/wake-lock.ts` + `bot-desk.tsx` — hold the screen wake lock
  while the bot runs; re-acquire on return-to-visible; release on stop.
