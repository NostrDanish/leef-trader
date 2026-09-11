import {
  parsePrivateKey as parseAntelopeKey,
  signDigest as antelopeSignDigest,
  type AntelopeKeyPair,
} from "./antelope";

/** In-memory only. Never written to disk, never sent to a server. */
let secret: AntelopeKeyPair | null = null;

export function hasSecret(): boolean {
  return secret != null;
}

export function forgetSecret(): void {
  secret = null;
}

export function describeKey(kp: AntelopeKeyPair): { publicKey: string; legacy: string } {
  return { publicKey: kp.publicKeyString, legacy: kp.legacyPublicKeyString };
}

export function importSecret(raw: string): { publicKey: string; legacy: string } {
  const kp = parseAntelopeKey(raw);
  secret = kp;
  return describeKey(kp);
}

/** Sign a 32-byte digest, returning a SIG_K1_… signature string. */
export function signDigest(digest: Uint8Array): string {
  if (!secret) throw new Error("No private key in this session");
  return antelopeSignDigest(digest, secret);
}

export function sessionPublic(): { publicKey: string; legacy: string } | null {
  if (!secret) return null;
  return describeKey(secret);
}

export { parseAntelopeKey as parsePrivateKey };
