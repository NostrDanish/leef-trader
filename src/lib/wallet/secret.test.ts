import { afterEach, describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AntelopeKeyPair } from "./antelope";

// Capture the exact key pair object secret.ts holds, via a pass-through mock.
vi.mock("./antelope", async (orig) => {
  const real = await orig<typeof import("./antelope")>();
  return { ...real, parsePrivateKey: vi.fn(real.parsePrivateKey) };
});

const antelope = await import("./antelope");
const { forgetSecret, hasSecret, importSecret, signDigest } = await import("./secret");

// A throwaway key generated per run — no key material lives in the repo.
// (The parser routes strings starting with "5" to the WIF decoder, so skip those.)
const freshHexKey = (): string => {
  for (;;) {
    const hex = bytesToHex(secp256k1.utils.randomSecretKey());
    if (!hex.startsWith("5")) return hex;
  }
};
const lastParsed = (): AntelopeKeyPair => {
  const results = vi.mocked(antelope.parsePrivateKey).mock.results;
  return results[results.length - 1]!.value as AntelopeKeyPair;
};

describe("session key zeroization", () => {
  afterEach(() => forgetSecret());

  it("forgetSecret overwrites the held private-key bytes and disables signing", () => {
    importSecret(freshHexKey());
    const held = lastParsed().privateKey;
    expect(hasSecret()).toBe(true);
    expect(held.some((b) => b !== 0)).toBe(true);
    expect(() => signDigest(new Uint8Array(32))).not.toThrow();

    forgetSecret();
    expect(hasSecret()).toBe(false);
    expect(held.every((b) => b === 0)).toBe(true);
    expect(() => signDigest(new Uint8Array(32))).toThrow(/No private key/);
  });

  it("importing a new key zeroizes the previous one", () => {
    importSecret(freshHexKey());
    const first = lastParsed().privateKey;
    importSecret(freshHexKey());
    const second = lastParsed().privateKey;
    expect(first.every((b) => b === 0)).toBe(true);
    expect(second.some((b) => b !== 0)).toBe(true);
  });

  it("forgetSecret is idempotent", () => {
    forgetSecret();
    forgetSecret();
    expect(hasSecret()).toBe(false);
  });
});
