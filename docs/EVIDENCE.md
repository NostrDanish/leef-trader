# Evidence Journal

The trader's persistent memory. Before this existed, every reload forgot
what the bot had learned — the in-memory decision log caps at 60 entries and
the persisted store keeps only aggregates. "Is this strategy actually making
money?" was unfalsifiable. The journal fixes that.

## What it is

One append-only log in IndexedDB (`leef-evidence` DB, `journal` store).
Every entry is a **compact flat record** — a few hundred bytes, never a
market snapshot (the universe is ~11 MB; snapshotting it per decision would
kill storage within days). Four kinds:

| Kind          | Written at                                   | Carries |
|---------------|----------------------------------------------|---------|
| `decision`    | every `pushDecision` (incl. HOLD, error)     | strategy, mode, kind, reason, price |
| `gate`        | every exact-quote gate verdict, pass OR fail | gate (entry/swap/growth), attempt #, expectedOut, guaranteedOut, exact net %, exactness, verify latency |
| `execution`   | every paper/live trade after broadcast       | pair, size, expected vs actual out, txid, chain-observed status, P&L, latency |
| `calibration` | every closed trade's predicted edge          | predicted edge % vs realized edge % |

## Design rules

- **Fire-and-forget.** `journal()` never throws into trading code. No
  IndexedDB (private mode) → silently disabled.
- **Buffered writes.** Entries batch in memory and flush every 4s / every 25
  entries / on tab hide — one IDB transaction per batch, not per event.
- **Bounded storage.** 60k entries hard cap; oldest pruned to 50k. ~15–25 MB
  worst case.
- **NDJSON export.** Evidence desk → "Export NDJSON" downloads the full log,
  oldest first — diffable, greppable, replayable offline.

## Why these shapes

- **Gate entries record the CP-model vs venue-CLMM disagreement rate.** The
  grouped failure signatures on the Evidence desk answer the open question:
  is constant-product discovery misranking routes often enough to justify
  reading `swap.alcor` tick tables for true CLMM-aware discovery? Measure
  first, build only if the data says so.
- **Calibration entries are per-trade**, not aggregates — the persisted store
  already keeps the sums; the journal keeps the distribution.
- **`attempt` on gate entries** shows how often candidate fallback (#2, #3)
  rescues a tick the winner failed.

## The desk

Terminal → **Evidence** tab: per-strategy decisions / HOLDs / trades / win
rate / P&L / predicted vs realized edge (calibration error) / gate pass-fail,
plus top gate-failure signatures and storage span. Refresh is manual — the
desk never polls in the background.

## What it is NOT

- Not a backtester. Recorded decisions can later feed a **decision replay**
  (would the current logic have acted differently on this tape?) and honest
  paper-forward evaluation — not a simulated-P&L fiction on a thin CLMM
  market where our own flow is a large share of volume.
- Not synced anywhere. Browser-local, export-before-you-clear-site-data.

See [TRADING_ENGINE](./TRADING_ENGINE.md) for the pipeline that produces the
journaled events and [NET_EDGE](./NET_EDGE.md) for the economics being
measured.
