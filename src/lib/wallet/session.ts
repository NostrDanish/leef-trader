/**
 * External wallet sessions (WAX Cloud Wallet + Anchor) via Wharfkit.
 *
 * Unlike the in-memory session key, these never see the key at all — each
 * trade pops the wallet to sign (Cloud Wallet users can whitelist the
 * swap.alcor transfers to trade without popups).
 */
import { SessionKit, type Session } from "@wharfkit/session";
import { WebRenderer } from "@wharfkit/web-renderer";
import { WalletPluginAnchor } from "@wharfkit/wallet-plugin-anchor";
import { WalletPluginCloudWallet } from "@wharfkit/wallet-plugin-cloudwallet";
import { effectiveEndpoints } from "@/lib/wax/endpoints";
import { rpcPool } from "@/lib/wax/provider-pool";

/** WAX mainnet chain id. */
export const WAX_CHAIN_ID =
  "1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4";

export type WalletKind = "wcw" | "anchor";

export type WalletIdentity = {
  account: string;
  permission: string;
  kind: WalletKind;
};

let kit: SessionKit | null = null;
let session: Session | null = null;

const CORS_PROXY = "https://proxy.shakespeare.diy/?url=";

/**
 * Wharfkit's internal chain calls get the same CORS-proxy fallback — but
 * only for READ calls. A signed transaction (push_transaction) must NEVER
 * be re-submitted through a third-party proxy: it would expose the signed
 * payload and silently double-submit a timed-out broadcast (the "exactly
 * one submission" invariant).
 */
export const proxyFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch (err) {
    // Wharfkit POSTs PackedTransaction JSON — the string "push_transaction"
    // appears in the URL, never the body — so gate on method/body instead:
    // only a bodyless GET (a read call) may fall through to the proxy.
    // A Request object carries its OWN method/body — check it too, or a
    // POST encoded as `new Request(url, { method: "POST", body })` would
    // slip through the init-only check and be proxied as a bodyless GET.
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const hasBody =
      init?.body != null || (input instanceof Request && input.body != null);
    const isGet = !hasBody && method === "GET";
    if (!isGet) throw err;
    const url =
      typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    return await fetch(`${CORS_PROXY}${encodeURIComponent(url)}`, init);
  }
};

/**
 * Ordered chain URLs for SessionKit. The provider pool's current
 * health-scored best goes first; the rest of the curated default list
 * (endpoints.ts) follows as simple failover. No single-host dependency:
 * a dead Greymass (or any one node) must not kill external wallets.
 */
function sessionChainUrls(): string[] {
  const urls = effectiveEndpoints()
    .rpc.filter((e) => e.enabled)
    .map((e) => e.url);
  const best = rpcPool.best()?.url;
  if (best && urls.includes(best)) {
    urls.splice(urls.indexOf(best), 1);
    urls.unshift(best);
  }
  return urls.length > 0 ? urls : ["https://wax.greymass.com"];
}

let kitUrl: string | null = null;

function makeKit(url: string): SessionKit {
  kitUrl = url;
  return new SessionKit(
    {
      appName: "LEEF Trader",
      chains: [{ id: WAX_CHAIN_ID, url }],
      ui: new WebRenderer(),
      walletPlugins: [new WalletPluginCloudWallet(), new WalletPluginAnchor()],
    },
    { fetch: proxyFetch },
  );
}

function getKit(): SessionKit {
  if (!kit) {
    kit = makeKit(sessionChainUrls()[0]!);
  }
  return kit;
}

/** True for network-level failures where trying the next endpoint helps —
 *  never for user cancels or wallet-side rejections. */
function isEndpointFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch failed / unreachable host
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  return (
    msg.includes("failed to fetch") ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("econnrefused") ||
    msg.includes("502") ||
    msg.includes("503")
  );
}

/** Rebuild the kit on the next curated endpoint after an endpoint failure. */
function rotateKit(): SessionKit {
  const urls = sessionChainUrls();
  const idx = kitUrl ? urls.indexOf(kitUrl) : -1;
  const next = urls[(idx + 1) % urls.length]!;
  kit = makeKit(next);
  return kit;
}

/** Run a SessionKit call with simple endpoint failover (network errors only). */
async function withKit<T>(fn: (k: SessionKit) => Promise<T>): Promise<T> {
  const attempts = Math.min(3, sessionChainUrls().length);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(getKit());
    } catch (err) {
      lastErr = err;
      if (!isEndpointFailure(err) || i === attempts - 1) throw err;
      rotateKit();
    }
  }
  throw lastErr;
}

export function walletSession(): Session | null {
  return session;
}

export function hasWalletSession(): boolean {
  return session != null;
}

function identityOf(s: Session): WalletIdentity {
  return {
    account: String(s.actor),
    permission: String(s.permission),
    kind: s.walletPlugin.id === "anchor" ? "anchor" : "wcw",
  };
}

/** Login via Cloud Wallet popup or Anchor. Opens the wallet's own UI. */
export async function loginWallet(kind: WalletKind): Promise<WalletIdentity> {
  const res = await withKit((k) =>
    k.login({
      walletPlugin: kind === "anchor" ? "anchor" : "cloudwallet",
    }),
  );
  session = res.session;
  return identityOf(res.session);
}

/** Restore a previous wallet session from storage (survives reloads). */
export async function restoreWallet(): Promise<WalletIdentity | null> {
  try {
    const s = await withKit((k) => k.restore());
    if (!s) return null;
    session = s;
    return identityOf(s);
  } catch {
    session = null;
    return null;
  }
}

export async function logoutWallet(): Promise<void> {
  try {
    if (session) await getKit().logout(session);
  } catch {
    /* best effort */
  } finally {
    session = null;
  }
}
