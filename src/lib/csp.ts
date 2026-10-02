/**
 * Content-Security-Policy, generated from the endpoint constants the app
 * actually talks to — one source of truth instead of `connect-src https: wss:`
 * (which let an XSS / supply-chain payload send the in-memory session key to
 * ANY host).
 *
 * Rollout (see docs/SECURITY.md → Web security):
 *  1. this policy ships as `Content-Security-Policy-Report-Only` in
 *     vercel.json (violations show in DevTools, nothing is blocked);
 *  2. after a clean preview smoke test of every desk + both wallets, the
 *     `index.html` meta tag switches to `buildCsp()` and it is enforced.
 *
 * `csp.test.ts` keeps vercel.json in lock-step with `buildCsp()` and fails
 * when an endpoint constant is added without landing here.
 */
import { DEFAULT_HISTORY_ENDPOINTS, DEFAULT_RPC_ENDPOINTS } from "@/lib/wax/endpoints";
import { DEFAULT_AI_GATEWAY } from "@/lib/leef/ai-analyst";
import { ROUTER as ALCOR_ROUTER } from "@/lib/wallet/alcor-route";
import { CORS_PROXY } from "@/lib/fetchJson";
import { APP_RELAYS } from "@/lib/appRelays";
import { APP_BLOSSOM_SERVERS } from "@/lib/appBlossom";

const origin = (url: string): string => new URL(url).origin;

/** Wallet hosts used by @wharfkit plugins (not referenced in src/). */
export const WALLET_ORIGINS = {
  /** Anchor ESR callback service (buoy) — https + wss. */
  anchorBuoy: ["https://cb.anchor.link", "wss://cb.anchor.link"],
  /** WAX Cloud Wallet (popup + fetch, may be framed). */
  cloudWallet: ["https://www.mycloudwallet.com"],
};

/** Fallback chain host used by the wallet session (session.ts sessionChainUrls). */
const SESSION_FALLBACK_RPC = "https://wax.greymass.com";

/** Every origin the app may `fetch` / open a WebSocket to. */
export function connectOrigins(): string[] {
  const chain = [...DEFAULT_RPC_ENDPOINTS, ...DEFAULT_HISTORY_ENDPOINTS].map((e) => origin(e.url));
  const nostr = APP_RELAYS.relays.map((r) => origin(r.url));
  const blossom = APP_BLOSSOM_SERVERS.servers.map(origin);
  return [
    ...new Set([
      ...chain,
      origin(SESSION_FALLBACK_RPC),
      origin(ALCOR_ROUTER),
      origin(CORS_PROXY), // GET-only read fallback (fetchJson.ts)
      origin(DEFAULT_AI_GATEWAY),
      ...WALLET_ORIGINS.anchorBuoy,
      ...WALLET_ORIGINS.cloudWallet,
      // Nostr template (login/relays/Blossom). Users' own NIP-65 relays are
      // NOT covered — drop these if Nostr login is removed.
      ...nostr,
      ...blossom,
    ]),
  ];
}

export function connectSrc(): string[] {
  return ["'self'", "blob:", ...connectOrigins()];
}

export function buildCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `frame-src 'self' ${WALLET_ORIGINS.cloudWallet.join(" ")}`,
    "font-src 'self'",
    "base-uri 'self'",
    "manifest-src 'self'",
    "form-action 'none'",
    "object-src 'none'",
    `connect-src ${connectSrc().join(" ")}`,
    "img-src 'self' data: blob: https:",
    "media-src 'self' https:",
  ].join("; ");
}
