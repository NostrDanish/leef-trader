# Deployment (Vercel)

LEEF Trader is a fully client-side Vite + React SPA: no backend, no server
functions, and **no environment variables**. All traffic goes directly from
the browser to public WAX RPC / Hyperion / Alcor endpoints.

## Deploy in ~2 minutes

1. Go to [vercel.com/new](https://vercel.com/new) and import this repository.
2. Vercel auto-detects the **Vite** framework (`framework: "vite"` in
   [`vercel.json`](../vercel.json)) and uses:
   - **Build command**: `npm run build`
     (`vite build -l error && cp dist/index.html dist/404.html`)
   - **Output directory**: `dist`
   - **Install command**: `npm install`
3. No environment variables to configure — just press **Deploy**.

Node: Vite 8 requires Node 20.19+/22+. `package.json` declares
`"engines": { "node": ">=20.19" }`; Vercel's default Node 22.x satisfies it.

## How the SPA is served

- `vercel.json` contains a catch-all rewrite
  `/(.*) -> /index.html`, so deep links (e.g. `/nip19...`) load the app and
  let BrowserRouter handle routing instead of returning a Vercel 404.
- `dist/404.html` is a copy of `index.html` (produced by the build script),
  which additionally covers hosts that serve a static 404 page.
- `/assets/*` files are content-hashed by Vite, so `vercel.json` sets
  `Cache-Control: public, max-age=31536000, immutable` on them for
  aggressive edge caching.

## Previews and rollbacks

Vercel's **native git integration** handles CI/CD — no extra workflow is
needed:

- Every push to a PR/branch gets an isolated **preview deployment** URL.
- Merges to `main` trigger a **production deployment**.
- **Rollback**: Vercel dashboard → your project → **Deployments** → find the
  last good deployment → **⋯ → Promote to Production** (instant, since
  artifacts are immutable). Redeploys can also be done with
  `vercel rollback` from the CLI.

Optional CLI flow (`npm i -g vercel`): run `vercel link` once to connect a
local checkout to the project, then `vercel` for a preview or
`vercel --prod` for production. This is not required — the git integration
is the recommended path. GitHub Actions in this repo only run checks
(`.github/workflows/ci.yml`); deployment is owned by Vercel.

## Other hosting artifacts (inert on Vercel — leave them in place)

The repo still carries configuration for other hosts. Vercel ignores all of
it, and other platforms still use it, so **do not delete**:

- `.gitlab-ci.yml` — GitLab Pages pipeline. Currently broken (no `npm ci`
  step, 1-minute default timeout) and unmaintained; GitHub Actions +
  Vercel are the working paths.
- `.nsite/` — Nostr-based static hosting configuration (nsite).
- `public/_redirects` — Netlify-style SPA redirect rules. Vercel ignores
  this file (it is copied verbatim into `dist/`); the `vercel.json` rewrite
  above is the Vercel equivalent.
- `.github/workflows/deploy.yml` — GitHub Pages deploy on pushes to `main`.
  Harmless alongside Vercel; disable it in repo settings if Pages is unused.
