import type { AntelopeKeyPair } from "./antelope";

/** In-memory only. Never written to disk, never sent to a server. */
let secret: AntelopeKeyPair | null = null;
let antelopeSign: ((digest: Uint8Array, keyPair: AntelopeKeyPair) => string) | null = null;

/** Antelope + noble stay out of the first-paint graph until a key is imported. */
async function loadAntelope(): Promise<typeof import("./antelope")> {
  const mod = await import("./antelope");
  antelopeSign = mod.signDigest;
  return mod;
}

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
  const { parsePrivateKey: parse } = await loadAntelope();
  return parse(raw);
}

export async function importSecret(raw: string): Promise<{ publicKey: string; legacy: string }> {
  const kp = await parsePrivateKey(raw);
  // Replacing a key must not leave the previous one's bytes behind.
  if (secret && secret !== kp) secret.privateKey.fill(0);
  secret = kp;
  return describeKey(kp);
}

/** Sign a 32-byte digest, returning a SIG_K1_… signature string. */
export function signDigest(digest: Uint8Array): string {
  if (!secret) throw new Error("No private key in this session");
  if (!antelopeSign) throw new Error("Key module is not loaded");
  return antelopeSign(digest, secret);
}

export function sessionPublic(): { publicKey: string; legacy: string } | null {
  if (!secret) return null;
  return describeKey(secret);
}
