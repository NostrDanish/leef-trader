# Testing

## Run

```bash
npm test          # tsc --noEmit → eslint → vitest → vite build
npx vitest run    # just the unit tests
```

Vitest runs hermetic: `getLeefSnapshot()` returns a static book in
`MODE === "test"` and never touches the network. jsdom + Testing Library +
jest-dom are preconfigured (`src/test/setup.ts` mocks matchMedia, scrollTo,
IntersectionObserver, ResizeObserver).

## What's covered

| File | Coverage |
|---|---|
| `src/lib/wallet/policy.test.ts` | Transaction policy firewall — memo parsing, allowlists, spoofed-token rejection, receiver pinning, LP action rules; arb profit floor incl. split legs, negative (volume) floors, spoofed min-outs, over-pulling buy legs |
| `src/lib/wallet/antelope.test.ts` | Custom signer pinned against `@wharfkit/antelope`: WIF/PVT_K1 keys (incl. the canonical EOSIO dev-key vector), name/asset/transfer packing at multiple precisions, TAPOS header, full transaction bytes, signing digest, SIG_K1 recovery + determinism |
| `src/lib/wallet/reconcile.test.ts` | Hyperion response parsing (foreign-account noise, spoofed-symbol transfers, not-yet-indexed shapes), net asset deltas, WAX resource-gate thresholds |
| `src/lib/leef/amm.test.ts` | Strict token identity (LEEF@leefmaincorp / WAX@eosio.token only), constant-product quote math |
| `src/lib/leef/net-edge.test.ts` | Cost model (fee+impact measured once, volatility scaling), size optimizer's interior maximum, do-nothing gate, explainable score, staleness gate, end-to-end `evaluateBot` buy/hold paths on a synthetic book |
| `src/App.test.tsx`, `src/test/ErrorBoundary.test.tsx`, `src/hooks/useLoginActions.test.tsx` | App shell smoke tests (template heritage) |

## Testing philosophy here

- The decision engine is pure — test it by construction, not by mocking
  the world.
- The signer is tested against a reference implementation, not against
  itself.
- The policy firewall and arb floor are tested with hostile inputs
  (spoofs, foreign receivers, malformed memos), not just happy paths.
- Paper mode and tests never broadcast. Nothing in the test suite can move
  funds: no network, no keys, no chain access.

## Adding tests

Colocate `*.test.ts(x)` next to the code. Wrap React renders in
`src/test/TestApp.tsx`. Pure functions need no wrapper.
