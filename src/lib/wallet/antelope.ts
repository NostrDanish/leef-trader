/**
 * Minimal Antelope (EOSIO/WAX) transaction signer.
 *
 * Implements just what the autoswap needs:
 *  - WIF / PVT_K1_ private key parsing
 *  - PUB_K1_ / legacy EOS public key formatting
 *  - eosio.token-compatible `transfer` action packing
 *  - TAPOS transaction packing + signing digest
 *  - deterministic K1 (secp256k1) signatures in the SIG_K1_ format
 *
 * Everything is dependency-light (@noble/*) and self-verifying: before a
 * signature leaves the module we recover the public key from it and compare
 * against the session key, so a malformed signature can never be broadcast.
 */
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { secp256k1 } from "@noble/curves/secp256k1";

/* ------------------------------------------------------------------ */
/* hex + bytes helpers                                                 */
/* ------------------------------------------------------------------ */

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error("Invalid hex string");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* base58 (Bitcoin alphabet, as used by EOSIO key formats)             */
/* ------------------------------------------------------------------ */

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map([...B58_ALPHABET].map((c, i) => [c, i]));

export function base58Encode(data: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of data) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const v = digits[i]! * 256 + carry;
      digits[i] = v % 58;
      carry = Math.floor(v / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "";
  for (const byte of data) {
    if (byte === 0) out += "1";
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]!];
  return out;
}

export function base58Decode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);
  const bytes: number[] = [0];
  for (const char of str) {
    const val = B58_MAP.get(char);
    if (val === undefined) throw new Error(`Invalid base58 character "${char}"`);
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i]! * 58 + carry;
      bytes[i] = v & 0xff;
      carry = v >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  for (const char of str) {
    if (char === "1") zeros++;
    else break;
  }
  const out = new Uint8Array(zeros + bytes.length);
  out.set(new Uint8Array(bytes.reverse()), zeros);
  return out;
}

/** EOSIO key checksum: first 4 bytes of RIPEMD160(data + suffix). */
function keyChecksum(data: Uint8Array, suffix: string | null): Uint8Array {
  const enc = new TextEncoder();
  const payload = suffix ? concat(data, enc.encode(suffix)) : data;
  return ripemd160(payload).slice(0, 4);
}

function base58CheckEncode(data: Uint8Array, suffix: string | null): string {
  return base58Encode(concat(data, keyChecksum(data, suffix)));
}

function base58CheckDecode(str: string, suffix: string | null): Uint8Array {
  const raw = base58Decode(str);
  if (raw.length < 5) throw new Error("Key is too short");
  const data = raw.slice(0, raw.length - 4);
  const check = raw.slice(raw.length - 4);
  const want = keyChecksum(data, suffix);
  if (!want.every((b, i) => b === check[i])) {
    throw new Error("Key checksum mismatch — a character is off");
  }
  return data;
}

/**
 * WIF private keys (5H/5J/5K…) are Bitcoin-style base58check: the checksum
 * is the first 4 bytes of DOUBLE SHA-256 — not the RIPEMD160 variant that
 * PUB_/PVT_/SIG_ strings use.
 */
function wifDecode(str: string): Uint8Array {
  const raw = base58Decode(str);
  if (raw.length < 5) throw new Error("Key is too short");
  const data = raw.slice(0, raw.length - 4);
  const check = raw.slice(raw.length - 4);
  const want = sha256(sha256(data)).slice(0, 4);
  if (!want.every((b, i) => b === check[i])) {
    throw new Error("Key checksum mismatch — a character is off");
  }
  if (data[0] !== 0x80) throw new Error("Not a WIF key");
  if (data.length === 33) return data.slice(1);
  // Bitcoin-style compressed-key WIF carries a trailing 0x01 marker.
  if (data.length === 34 && data[33] === 0x01) return data.slice(1, 33);
  throw new Error("Malformed WIF payload");
}

/* ------------------------------------------------------------------ */
/* private / public key handling                                       */
/* ------------------------------------------------------------------ */

export type AntelopeKeyPair = {
  /** 32-byte secp256k1 private key. */
  privateKey: Uint8Array;
  /** 33-byte compressed public key. */
  publicKey: Uint8Array;
  /** PUB_K1_… representation. */
  publicKeyString: string;
  /** Legacy EOS… representation (used by some WAX tooling). */
  legacyPublicKeyString: string;
};

export function parsePrivateKey(raw: string): AntelopeKeyPair {
  const s = raw.trim().replace(/\s+/g, "");
  if (!s) throw new Error("Paste a WAX private key");
  if (s.length < 16) throw new Error("That does not look like a key");

  let priv: Uint8Array | null = null;
  let lastError = "Could not read that key";

  const attempts: (() => Uint8Array)[] = [];
  if (s.startsWith("PVT_K1_")) {
    attempts.push(() => base58CheckDecode(s.slice(7), "K1"));
  } else if (s.startsWith("PVT_R1_")) {
    throw new Error("R1 keys aren't supported — import the K1 key (WIF 5… or PVT_K1_)");
  } else if (s.startsWith("5") || s.startsWith("K") || s.startsWith("L")) {
    attempts.push(() => wifDecode(s));
  } else if (/^[0-9a-fA-F]{64}$/.test(s)) {
    attempts.push(() => hexToBytes(s));
  }

  for (const attempt of attempts) {
    try {
      const candidate = attempt();
      if (candidate.length !== 32) throw new Error("Key must be 32 bytes");
      if (!secp256k1.utils.isValidPrivateKey(candidate)) {
        throw new Error("Key is outside the secp256k1 range");
      }
      priv = candidate;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : lastError;
    }
  }

  if (!priv) {
    throw new Error(
      `${lastError}. Use a WIF key (starts with 5) or PVT_K1_. Nothing is stored on a server.`,
    );
  }
  return keyPairFromPrivate(priv);
}

export function keyPairFromPrivate(privateKey: Uint8Array): AntelopeKeyPair {
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  return {
    privateKey,
    publicKey,
    publicKeyString: `PUB_K1_${base58CheckEncode(publicKey, "K1")}`,
    legacyPublicKeyString: `EOS${base58CheckEncode(publicKey, null)}`,
  };
}

/* ------------------------------------------------------------------ */
/* signatures                                                          */
/* ------------------------------------------------------------------ */

function bigTo32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Legacy EOSIO canonical-signature check. */
function isCanonical(r: Uint8Array, s: Uint8Array): boolean {
  return (
    (r[0]! & 0x80) === 0 &&
    !(r[0] === 0 && (r[1]! & 0x80) === 0) &&
    (s[0]! & 0x80) === 0 &&
    !(s[0] === 0 && (s[1]! & 0x80) === 0)
  );
}

/**
 * Sign a 32-byte digest with the session key, returning SIG_K1_…
 * Self-verifies by recovering the public key before returning.
 */
export function signDigest(digest: Uint8Array, keyPair: AntelopeKeyPair): string {
  if (digest.length !== 32) throw new Error("Digest must be 32 bytes");

  for (let round = 0; round < 64; round++) {
    let extraEntropy: Uint8Array | undefined;
    if (round > 0) {
      extraEntropy = new Uint8Array(32);
      extraEntropy[31] = round;
    }
    const sig = secp256k1.sign(digest, keyPair.privateKey, {
      lowS: true,
      extraEntropy,
    });
    const r = bigTo32(sig.r);
    const s = bigTo32(sig.s);
    if (!isCanonical(r, s)) continue;
    const recovery = sig.recovery ?? 0;
    const data = concat(new Uint8Array([27 + 4 + recovery]), r, s);

    // Self-check: the recovered key must be our key.
    const recovered = sig.recoverPublicKey(digest);
    if (!recovered || bytesToHex(recovered.toRawBytes(true)) !== bytesToHex(keyPair.publicKey)) {
      continue;
    }
    return `SIG_K1_${base58CheckEncode(data, "K1")}`;
  }
  throw new Error("Could not produce a canonical signature");
}

/* ------------------------------------------------------------------ */
/* ABI serialization                                                   */
/* ------------------------------------------------------------------ */

class Writer {
  private chunks: number[] = [];

  u8(v: number): this {
    this.chunks.push(v & 0xff);
    return this;
  }

  u16(v: number): this {
    this.chunks.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }

  u32(v: number): this {
    this.chunks.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }

  u64(v: bigint): this {
    let n = v;
    for (let i = 0; i < 8; i++) {
      this.chunks.push(Number(n & 0xffn));
      n >>= 8n;
    }
    return this;
  }

  i64(v: bigint): this {
    return this.u64(BigInt.asUintN(64, v));
  }

  varuint(v: number): this {
    let n = v >>> 0;
    for (;;) {
      let b = n & 0x7f;
      n >>>= 7;
      if (n) b |= 0x80;
      this.chunks.push(b);
      if (!n) break;
    }
    return this;
  }

  bytes(data: Uint8Array): this {
    for (const b of data) this.chunks.push(b);
    return this;
  }

  string(s: string): this {
    const enc = new TextEncoder().encode(s);
    this.varuint(enc.length);
    this.bytes(enc);
    return this;
  }

  name(value: string): this {
    return this.u64(nameToBigInt(value));
  }

  done(): Uint8Array {
    return new Uint8Array(this.chunks);
  }
}

const NAME_CHARS = ".12345abcdefghijklmnopqrstuvwxyz";

function charToSymbol(c: string): bigint {
  const i = NAME_CHARS.indexOf(c);
  if (i === -1) throw new Error(`Invalid character "${c}" in an Antelope name`);
  return BigInt(i);
}

/** EOSIO name → uint64 (12×5-bit chars + 1×4-bit char). */
export function nameToBigInt(name: string): bigint {
  if (name.length > 13) throw new Error(`Name "${name}" is longer than 13 characters`);
  let value = 0n;
  for (let i = 0; i <= 12; i++) {
    const c = i < name.length ? charToSymbol(name[i]!) : 0n;
    if (i < 12) {
      value |= (c & 0x1fn) << BigInt(64 - 5 * (i + 1));
    } else {
      value |= c & 0x0fn;
    }
  }
  return BigInt.asUintN(64, value);
}

export type ParsedAsset = {
  /** Integer amount in the smallest unit. */
  amount: bigint;
  precision: number;
  symbol: string;
};

/** Parse "10.00000000 WAX" into amount/precision/symbol. */
export function parseAssetString(quantity: string): ParsedAsset {
  const m = quantity.trim().match(/^(\d+)(?:\.(\d+))? ([A-Z]{1,7})$/);
  if (!m) throw new Error(`Bad asset "${quantity}" — expected "1.0000 WAX"`);
  const whole = m[1]!;
  const frac = m[2] ?? "";
  const precision = frac.length;
  const amount = BigInt(whole + frac);
  if (amount < 0n) throw new Error("Negative assets are not supported");
  return { amount, precision, symbol: m[3]! };
}

function writeAsset(w: Writer, asset: ParsedAsset): void {
  w.i64(asset.amount);
  w.u8(asset.precision);
  const enc = new TextEncoder().encode(asset.symbol);
  if (enc.length > 7) throw new Error(`Symbol "${asset.symbol}" too long`);
  w.bytes(enc);
  for (let i = enc.length; i < 7; i++) w.u8(0);
}

/* ------------------------------------------------------------------ */
/* transactions                                                        */
/* ------------------------------------------------------------------ */

export type TransferActionData = {
  from: string;
  to: string;
  /** Asset string, e.g. "10.00000000 WAX". */
  quantity: string;
  memo: string;
};

export type TransactionSpec = {
  /** unix seconds */
  expiration: number;
  refBlockNum: number;
  refBlockPrefix: number;
  actions: {
    account: string;
    name: string;
    actor: string;
    /** Permission the actor signs with, e.g. "active". */
    permission: string;
    data: TransferActionData;
  }[];
};

function packTransfer(data: TransferActionData): Uint8Array {
  const w = new Writer();
  w.name(data.from);
  w.name(data.to);
  writeAsset(w, parseAssetString(data.quantity));
  w.string(data.memo);
  return w.done();
}

export function packTransaction(spec: TransactionSpec): Uint8Array {
  const w = new Writer();
  w.u32(spec.expiration);
  w.u16(spec.refBlockNum & 0xffff);
  w.u32(spec.refBlockPrefix >>> 0);
  w.varuint(0); // max_net_usage_words
  w.u8(0); // max_cpu_usage_ms
  w.varuint(0); // delay_sec
  w.varuint(0); // context_free_actions
  w.varuint(spec.actions.length);
  for (const action of spec.actions) {
    const dataBytes = packTransfer(action.data);
    w.name(action.account);
    w.name(action.name);
    w.varuint(1); // one authorization
    w.name(action.actor);
    w.name(action.permission);
    w.varuint(dataBytes.length);
    w.bytes(dataBytes);
  }
  w.varuint(0); // transaction_extensions
  return w.done();
}

/** sha256(chain_id + packed_tx + 32 zero context-free bytes). */
export function signingDigest(chainIdHex: string, packedTx: Uint8Array): Uint8Array {
  const chainId = hexToBytes(chainIdHex);
  if (chainId.length !== 32) throw new Error("Chain id must be 32 bytes");
  return sha256(concat(chainId, packedTx, new Uint8Array(32)));
}

export type ChainInfo = {
  chain_id: string;
  head_block_time: string;
  last_irreversible_block_num: number;
  last_irreversible_block_id: string;
};

/** TAPOS header fields from /v1/chain/get_info, mirroring alcor-ui/wharfkit. */
export function transactionHeaderFromInfo(
  info: ChainInfo,
  expireSeconds = 90,
): { expiration: number; refBlockNum: number; refBlockPrefix: number } {
  const headMs = Date.parse(info.head_block_time.endsWith("Z")
    ? info.head_block_time
    : `${info.head_block_time}Z`);
  if (!Number.isFinite(headMs)) throw new Error("Bad head_block_time from the chain");
  const blockId = hexToBytes(info.last_irreversible_block_id);
  if (blockId.length !== 32) throw new Error("Bad last_irreversible_block_id from the chain");
  const prefix =
    (blockId[8]! | (blockId[9]! << 8) | (blockId[10]! << 16) | (blockId[11]! << 24)) >>> 0;
  return {
    expiration: Math.floor(headMs / 1000) + expireSeconds,
    refBlockNum: info.last_irreversible_block_num & 0xffff,
    refBlockPrefix: prefix,
  };
}

/** Body for /v1/chain/push_transaction. */
export function packedTransactionBody(packedTx: Uint8Array, signatures: string[]) {
  return {
    signatures,
    compression: 0,
    packed_context_free_data: "",
    packed_trx: bytesToHex(packedTx),
  };
}
