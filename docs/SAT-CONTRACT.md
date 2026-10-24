# SAT treasury tab (leeftrader contract link)

Status: **deployed on WAX mainnet** (Oct 23 2026, `smartatrader` + SAT token `sattoken1111`, admin 2-of-3 `smartaadmin1`, low caps, not audited); the tab shows "not deployed" until `get_code_hash` on the account is non-zero.

- Contract source/spec: private repo `leeftoken/leef-trader-tg`, `contracts/` + `docs/CONTRACTS.md`.
- Account: `VITE_SAT_CONTRACT`, default `smartatrader` (owner choice; 12 chars, regular `newaccount`).
- Reads (`get_table_rows`): `plans`, `splits`, `buckets` (scope = bucket name), `lps`, `subs` (lower_bound = user). Alcor lock proof: `swap.alcor` `locks`.
- History (Hyperion `get_actions`, filter `<contract>:logrevenue,logsub,logswap,loglp`) — next step for an activity feed.
- Write: only the user's own subscription payment, `transfer(user → contract, plan price, "sub:<plan>")`, signed in the user's existing Wharfkit session (Cloud Wallet / Anchor). No treasury actions (buyback, addlp, payout, pause) are built or signed by the web app.
- Code: `src/lib/sat/contract.ts` (+ tests), `src/components/terminal/sat-desk.tsx`, tab `sat`.
