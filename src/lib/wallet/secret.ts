import {
  parsePrivateKey as parseAntelopeKey,
  signDigest as antelopeSignDigest,
  type AntelopeKeyPair,
} from "./antelope";
import { forgetSecret, hasSecret, peekSecret, rememberSecret } from "./secret-state";

export { forgetSecret, hasSecret };

export function describeKey(kp: AntelopeKeyPair): { publicKey: string; legacy: string } {
  return { publicKey: kp.publicKeyString, legacy: kp.legacyPublicKeyString };
}

export function importSecret(raw: string): { publicKey: string; legacy: string } {
  const kp = parseAntelopeKey(raw);
  rememberSecret(kp);
  return describeKey(kp);
}

/** Sign a 32-byte digest, returning a SIG_K1_… signature string. */
export function signDigest(digest: Uint8Array): string {
  const secret = peekSecret();
  if (!secret) throw new Error("No private key in this session");
  return antelopeSignDigest(digest, secret);
}

export function sessionPublic(): { publicKey: string; legacy: string } | null {
  const secret = peekSecret();
  if (!secret) return null;
  return describeKey(secret);
}

export { parseAntelopeKey as parsePrivateKey };
