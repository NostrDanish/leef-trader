/**
 * External-wallet session handle.
 *
 * Kept free of Wharfkit so the trading terminal can ask "is a wallet
 * connected?" without downloading the session stack. `session.ts` (dynamic)
 * is the only module that constructs the real SessionKit object and writes
 * it here.
 */

export type WalletKind = "wcw" | "anchor";

export type WalletTransactAction = {
  account: string;
  name: string;
  authorization: { actor: string; permission: string }[];
  data: Record<string, unknown>;
};

/** The slice of a Wharfkit Session the signer and logout path actually use. */
export type ExternalWalletSession = {
  actor: unknown;
  permission: unknown;
  walletPlugin: { id: string };
  transact: (input: { actions: WalletTransactAction[] }) => Promise<unknown>;
};

let session: ExternalWalletSession | null = null;

export function walletSession(): ExternalWalletSession | null {
  return session;
}

export function hasWalletSession(): boolean {
  return session != null;
}

export function setExternalSession(next: ExternalWalletSession | null): void {
  session = next;
}
