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
    const isGet = !init?.body && (!init?.method || init.method === "GET");
    if (!isGet) throw err;
    const url =
      typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    return await fetch(`${CORS_PROXY}${encodeURIComponent(url)}`, init);
  }
};

function getKit(): SessionKit {
  if (!kit) {
    kit = new SessionKit(
      {
        appName: "LEEF Trader",
        chains: [{ id: WAX_CHAIN_ID, url: "https://wax.greymass.com" }],
        ui: new WebRenderer(),
        walletPlugins: [new WalletPluginCloudWallet(), new WalletPluginAnchor()],
      },
      { fetch: proxyFetch },
    );
  }
  return kit;
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
  const res = await getKit().login({
    walletPlugin: kind === "anchor" ? "anchor" : "cloudwallet",
  });
  session = res.session;
  return identityOf(res.session);
}

/** Restore a previous wallet session from storage (survives reloads). */
export async function restoreWallet(): Promise<WalletIdentity | null> {
  try {
    const s = await getKit().restore();
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
