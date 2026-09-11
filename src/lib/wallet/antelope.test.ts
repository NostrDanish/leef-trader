/**
 * Reference test vectors for the custom Antelope signer.
 *
 * The custom implementation (antelope.ts) is security-critical: a wrong byte
 * in name/asset/transaction packing or a malformed signature means lost or
 * unspendable funds. These tests pin it against @wharfkit/antelope — the
 * audited reference implementation we already ship for wallet sessions — plus
 * the canonical EOSIO development key vector.
 */
import { describe, expect, it } from "vitest";
import {
  Asset,
  Name,
  PrivateKey,
  Serializer,
  Signature,
  Transaction,
} from "@wharfkit/antelope";
import {
  bytesToHex,
  hexToBytes,
  nameToBigInt,
  packTransferData,
  packTransaction,
  parsePrivateKey,
  signDigest,
  signingDigest,
  transactionHeaderFromInfo,
} from "./antelope";

/** The canonical EOSIO development key pair (documented in eosio/eosjs). */
const DEV_WIF = "5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3";
const DEV_PUB_LEGACY = "EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV";

const WAX_CHAIN_ID =
  "1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4";

const TRANSFER = {
  from: "trader.leef",
  to: "swap.alcor",
  quantity: "10.00000000 WAX",
  memo: "swapexactin#1159#trader.leef#240000.0000 LEEF@leefmaincorp#0",
};

/** Fixed chain info → deterministic TAPOS header for the packing tests. */
const CHAIN_INFO = {
  chain_id: WAX_CHAIN_ID,
  head_block_time: "2026-09-11T12:00:00.000",
  last_irreversible_block_num: 287_364_123,
  last_irreversible_block_id:
    "11264f1b8a0e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b",
};

function ourPackedTx(): Uint8Array {
  const header = transactionHeaderFromInfo(CHAIN_INFO, 90);
  return packTransaction({
    ...header,
    actions: [
      {
        account: "eosio.token",
        name: "transfer",
        actor: TRANSFER.from,
        permission: "active",
        dataBytes: packTransferData(TRANSFER),
      },
    ],
  });
}

describe("key parsing", () => {
  it("derives the canonical dev public key from the dev WIF", () => {
    const kp = parsePrivateKey(DEV_WIF);
    expect(kp.legacyPublicKeyString).toBe(DEV_PUB_LEGACY);
    // Cross-check both string forms against wharfkit's own derivation.
    const ref = PrivateKey.from(DEV_WIF).toPublic();
    expect(kp.publicKeyString).toBe(ref.toString());
    expect(kp.legacyPublicKeyString).toBe(ref.toLegacyString());
  });

  it("parses PVT_K1_ strings (wharfkit round-trip)", () => {
    const pvt = PrivateKey.from(DEV_WIF).toString();
    expect(pvt.startsWith("PVT_K1_")).toBe(true);
    const kp = parsePrivateKey(pvt);
    expect(kp.publicKeyString).toBe(PrivateKey.from(DEV_WIF).toPublic().toString());
  });

  it("rejects bad checksums, R1 keys and garbage", () => {
    // Last character changed → checksum mismatch.
    expect(() =>
      parsePrivateKey("5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD4"),
    ).toThrow(/checksum/i);
    expect(() => parsePrivateKey("PVT_R1_2foo")).toThrow(/R1/);
    expect(() => parsePrivateKey("not a key")).toThrow();
    expect(() => parsePrivateKey("")).toThrow();
  });
});

describe("name packing", () => {
  it("matches wharfkit Name values", () => {
    const names = [
      "eosio",
      "eosio.token",
      "swap.alcor",
      "leefmaincorp",
      "trader.leef",
      "a",
      "zzzzzzzzzzzzj", // max 13-char name (last char is 4-bit)
    ];
    for (const n of names) {
      expect(nameToBigInt(n).toString()).toBe(Name.from(n).value.toString());
    }
  });
});

describe("action data packing", () => {
  it("packs transfer data byte-identically to wharfkit", () => {
    const ours = packTransferData(TRANSFER);
    const ref = new Uint8Array([
      ...Serializer.encode({ object: Name.from(TRANSFER.from), type: Name }).array,
      ...Serializer.encode({ object: Name.from(TRANSFER.to), type: Name }).array,
      ...Serializer.encode({ object: Asset.from(TRANSFER.quantity), type: Asset }).array,
      ...Serializer.encode({ object: TRANSFER.memo, type: "string" }).array,
    ]);
    expect(bytesToHex(ours)).toBe(bytesToHex(ref));
  });

  it("packs multi-precision assets identically to wharfkit", () => {
    for (const q of ["1.00000000 WAX", "240000.0000 LEEF", "0.000001 WAXUSDC"]) {
      const ours = packTransferData({ ...TRANSFER, quantity: q });
      const ref = new Uint8Array([
        ...Serializer.encode({ object: Name.from(TRANSFER.from), type: Name }).array,
        ...Serializer.encode({ object: Name.from(TRANSFER.to), type: Name }).array,
        ...Serializer.encode({ object: Asset.from(q), type: Asset }).array,
        ...Serializer.encode({ object: TRANSFER.memo, type: "string" }).array,
      ]);
      expect(bytesToHex(ours)).toBe(bytesToHex(ref));
    }
  });
});

describe("transaction packing", () => {
  it("derives the TAPOS header from chain info", () => {
    const h = transactionHeaderFromInfo(CHAIN_INFO, 90);
    const expSec = Math.floor(Date.parse("2026-09-11T12:00:00.000Z") / 1000) + 90;
    expect(h.expiration).toBe(expSec);
    expect(h.refBlockNum).toBe(287_364_123 & 0xffff);
    const idBytes = hexToBytes(CHAIN_INFO.last_irreversible_block_id);
    const wantPrefix =
      (idBytes[8]! | (idBytes[9]! << 8) | (idBytes[10]! << 16) | (idBytes[11]! << 24)) >>> 0;
    expect(h.refBlockPrefix).toBe(wantPrefix);
  });

  it("packs a full transaction byte-identically to wharfkit", () => {
    const h = transactionHeaderFromInfo(CHAIN_INFO, 90);
    const expStr = new Date(h.expiration * 1000).toISOString().slice(0, 19);
    const ref = Transaction.from({
      expiration: expStr,
      ref_block_num: h.refBlockNum,
      ref_block_prefix: h.refBlockPrefix,
      max_net_usage_words: 0,
      max_cpu_usage_ms: 0,
      delay_sec: 0,
      context_free_actions: [],
      actions: [
        {
          account: "eosio.token",
          name: "transfer",
          authorization: [{ actor: TRANSFER.from, permission: "active" }],
          data: bytesToHex(packTransferData(TRANSFER)),
        },
      ],
      transaction_extensions: [],
    });
    const refPacked = Serializer.encode({ object: ref, type: Transaction }).array;
    expect(bytesToHex(ourPackedTx())).toBe(bytesToHex(refPacked));
  });

  it("computes the same signing digest as wharfkit", () => {
    const h = transactionHeaderFromInfo(CHAIN_INFO, 90);
    const expStr = new Date(h.expiration * 1000).toISOString().slice(0, 19);
    const ref = Transaction.from({
      expiration: expStr,
      ref_block_num: h.refBlockNum,
      ref_block_prefix: h.refBlockPrefix,
      max_net_usage_words: 0,
      max_cpu_usage_ms: 0,
      delay_sec: 0,
      context_free_actions: [],
      actions: [
        {
          account: "eosio.token",
          name: "transfer",
          authorization: [{ actor: TRANSFER.from, permission: "active" }],
          data: bytesToHex(packTransferData(TRANSFER)),
        },
      ],
      transaction_extensions: [],
    });
    const refDigest = ref.signingDigest(WAX_CHAIN_ID);
    const ours = signingDigest(WAX_CHAIN_ID, ourPackedTx());
    expect(bytesToHex(ours)).toBe(bytesToHex(refDigest.array));
  });
});

describe("signatures", () => {
  it("produces SIG_K1 signatures wharfkit recovers to the same key", () => {
    const kp = parsePrivateKey(DEV_WIF);
    const digest = signingDigest(WAX_CHAIN_ID, ourPackedTx());
    const sig = signDigest(digest, kp);
    expect(sig.startsWith("SIG_K1_")).toBe(true);
    const recovered = Signature.from(sig).recoverDigest(digest);
    expect(recovered.toString()).toBe(kp.publicKeyString);
    expect(recovered.toLegacyString()).toBe(DEV_PUB_LEGACY);
  });

  it("is deterministic — same digest, same signature", () => {
    const kp = parsePrivateKey(DEV_WIF);
    const digest = signingDigest(WAX_CHAIN_ID, ourPackedTx());
    expect(signDigest(digest, kp)).toBe(signDigest(digest, kp));
  });

  it("rejects a malformed digest length", () => {
    const kp = parsePrivateKey(DEV_WIF);
    expect(() => signDigest(new Uint8Array(16), kp)).toThrow(/32 bytes/);
  });
});
