# AI Analyst

Optional second-opinion layer, powered by your own AI gateway
([Leef-signer](https://github.com/NostrDanish/Leef-signer) — a Cloudflare
Worker you deploy, holding your own provider key as a Worker Secret).

```
AI desk (browser)                     your Cloudflare Worker              PPQ
  compact JSON context  ──POST /api/ai──▶  server system prompt   ──▶  deepseek
  (prices, stats,                     + forced model + JSON mode        (ZDR)
   evidence aggregates)                    + rate limit + timeout
                  ◀── chat completion (analysis JSON) ──
```

## The invariant that matters

**The AI is an analyst, never the trading engine.**

- Nothing from the gateway is on the trade path. Strategies, NetEdge, the
  exact-quote gates, the governor and the policy firewall decide and execute
  exactly as before — fully deterministically.
- The worker itself forces `"trade_authorization": false` into every
  response; the desk strips that key before display.
- Gateway down, slow, CORS-blocked or over budget → the desk shows the error;
  trading is unaffected. Client timeout 35s: the worker caps upstream
  generation at 30s (ZDR flash generates ~30–60 tok/s; a full analysis is
  6–25s). AI calls are fire-and-forget outside the trading loop, so the cap
  only ever bounds the analysis fetch — never a trade.
- Every AI call is written to the [evidence journal](./EVIDENCE.md)
  (`kind: "ai"`, task + latency + digest) so the analyst's own track record
  is auditable — but AI entries never touch per-strategy trading statistics.

## Tasks

| Task                 | Context sent (compact — scalars and short lists, never raw snapshots) |
|----------------------|------------------------------------------------------------------------|
| `market_analysis`    | LEEF/WAX marks, WAX-oracle quality, top-6 LEEF pools, last 8 tape prints, bot mode + last 5 decision reasons |
| `strategy_analysis`  | Full bot config (goals/risk), session P&L, open position, per-strategy calibration aggregates |
| `evidence_review`    | The aggregated evidence journal: per-strategy evidence + grouped gate-failure signatures |

There is also a **growth-target mix suggester** on the Bot desk's Treasure
card (`strategy_analysis` with `mode: "growth_target_selection"`): the
analyst ranks liquid, venue-trusted universe tokens into a 1–5 mix, a human
applies it, and the deterministic growth engine trades it through the same
gates as everything else.

The worker pairs `data` with its own server-side system prompt — the client
cannot inject a system prompt or pick a different model.

## Master switch

The AI desk has an **AI on/off toggle** (persisted per browser). Off means
exactly zero calls leave the browser — no health ping, no tasks. Trading
never depends on the analyst either way.

## Setup checklist

1. Deploy your gateway with Leef-signer (default URL preset is already in
   the desk; the URL is editable and persisted per-browser).
2. **CORS**: the worker must return `Access-Control-Allow-Origin` for THIS
   deployment's origin on both the OPTIONS preflight and the POST response —
   the desk shows the exact origin string to add when calls fail. (If every
   origin gets a headerless 200 on preflight, redeploy the worker with the
   CORS allowlist filled in — the Leef-signer wizard's Security step.)
3. Rate limit: the worker allows 20 req/min per IP; the desk budgets 18 and
   shows the remaining count.

## Troubleshooting

- **`Gateway HTTP 504 — PROVIDER_TIMEOUT`**: the upstream model did not
  answer within the worker's 30s cap. Check the model id (`PPQ_MODEL` var),
  PPQ status, or try a faster model from the `/v1/models` catalog.
- **`Unreachable / CORS` badge**: DNS/offline, or the origin is not
  allowlisted (see checklist #2).
- Health check (`GET /api/health`) validates the PPQ key without spending a
  model call — the desk pings it on open.
