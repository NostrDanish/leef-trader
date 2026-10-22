import BufferModule from "buffer";

/**
 * Wharfkit and the Nostr stack read `globalThis.Buffer` at module init.
 * Loaded only with those chunks — the trading terminal does not need it.
 */
if (!globalThis.Buffer) {
  globalThis.Buffer = BufferModule.Buffer;
}
