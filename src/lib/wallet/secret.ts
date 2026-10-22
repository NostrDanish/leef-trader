import type { AntelopeKeyPair } from "./antelope";

/**
 * @noble curves/hashes are the heavy part of key import. The shell only
 * needs `hasSecret` / `forgetSecret`, so the signer module loads on the
 * first import — and stays loaded for the synchronous `signDigest` calls
 * the trade path makes after that.
 */
type AntelopeModule = typeof import("./antelope");

let antelope: AntelopeModule | null = null;
let antelopePromise: Promise<AntelopeModule> | null = null;

function loadAntelope(): Promise<AntelopeModule> {
  antelopePromise ??= import("./antelope").then((mod) => {
    antelope = mod;
    return mod;
  });
  return antelopePromise;
}

/** In-memory only. Never written to disk, never sent to a server. */
let secret: AntelopeKeyPair | null = null;

export function hasSecret(): boolean {
  return secret != null;
}

/**
 * Drop the session key and overwrite the 32 private-key bytes we own, so a
 * held reference (or a heap snapshot taken later) no longer contains them.
 * Limit: the pasted WIF *string* is immutable in JS and lives until GC.
 */
export function forgetSecret(): void {
  if (secret) {
    secret.privateKey.fill(0);
    secret = null;
  }
}

export function describeKey(kp: AntelopeKeyPair): { publicKey: string; legacy: string } {
  return { publicKey: kp.publicKeyString, legacy: kp.legacyPublicKeyString };
}

export async function parsePrivateKey(raw: string): Promise<AntelopeKeyPair> {
  const mod = await loadAntelope();
  return mod.parsePrivateKey(raw);
}

export async function importSecret(raw: string): Promise<{ publicKey: string; legacy: string }> {
  const mod = await loadAntelope();
  const kp = mod.parsePrivateKey(raw);
  // Replacing a key must not leave the previous one's bytes behind.
  if (secret && secret !== kp) secret.privateKey.fill(0);
  secret = kp;
  return describeKey(kp);
}

/** Sign a 32-byte digest, returning a SIG_K1_… signature string. */
export function signDigest(digest: Uint8Array): string {
  if (!secret || !antelope) throw new Error("No private key in this session");
  return antelope.signDigest(digest, secret);
}

export function sessionPublic(): { publicKey: string; legacy: string } | null {
  if (!secret) return null;
  return describeKey(secret);
}
