import type { AntelopeKeyPair } from "./antelope";

/**
 * In-memory session key. This module does not import the signer, so the
 * shell can check `hasSecret()` / drop the key without pulling @noble into
 * the initial bundle. `secret.ts` is the only writer of key bytes.
 */

let secret: AntelopeKeyPair | null = null;

export function hasSecret(): boolean {
  return secret != null;
}

export function peekSecret(): AntelopeKeyPair | null {
  return secret;
}

/** Replace the held key, zeroizing the previous one first. */
export function rememberSecret(kp: AntelopeKeyPair): void {
  if (secret && secret !== kp) secret.privateKey.fill(0);
  secret = kp;
}

/**
 * Drop the session key and overwrite the 32 private-key bytes we own, so a
 * held reference (or a heap snapshot taken later) no longer contains them.
 * Limit: the pasted WIF string is immutable in JS and lives until GC.
 */
export function forgetSecret(): void {
  if (secret) {
    secret.privateKey.fill(0);
    secret = null;
  }
}
