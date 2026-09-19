# Performance baseline (pre code-split)

Measured on `upgrade/vercel-best` HEAD before the `feat/perf` pass
(`npm run build`, Vite 8 / rolldown).

## Bundle

- `dist/` total: **4,464,822 B (4.3 MB)**, 58 assets
- JS: **one single chunk** `index-B3-Wmz5z.js` = **2,234,257 B raw / 682,415 B gzip**
- CSS: `index-pFAzmApa.css` = 144,233 B raw / 22,273 B gzip
- Everything shipped in the initial graph: 13 terminal desks (incl. recharts,
  the 1586-line bot desk, AI desk), the full Nostr stack (@nostrify,
  nostr-tools, isomorphic-ws), the Wharfkit session stack, qrcode,
  react-day-picker, embla, cmdk, vaul and 48 shadcn primitives.
- No `manualChunks` in `vite.config.ts`.

## Largest baseline assets (`ls -laS dist/assets | head`)

```
-rw-r--r-- 1 root root 2234257 index-B3-Wmz5z.js
-rw-r--r-- 1 root root  144233 index-pFAzmApa.css
-rw-r--r-- 1 root root   24252 ibm-plex-sans-latin-600-normal-CuJfVYMP.woff2
-rw-r--r-- 1 root root   24184 ibm-plex-sans-latin-500-normal-6ng42L7E.woff2
-rw-r--r-- 1 root root   23916 ibm-plex-sans-latin-500-normal-BgVn5rGT.woff
```

Post-split numbers are recorded in the `feat/perf` final report / PR
description.
