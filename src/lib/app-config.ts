import type { AppConfig, BlossomServerMetadata, RelayMetadata, Theme } from "@/contexts/AppContext";

/**
 * Validate the persisted app config without pulling Zod into the first-paint
 * bundle. Same contract as the previous schema: partial objects are accepted,
 * unknown keys are dropped, and a wrong type throws so the caller can fall
 * back to defaults.
 */
export function parsePartialAppConfig(value: unknown): Partial<AppConfig> {
  const record = asRecord(value, "App config");
  const out: Partial<AppConfig> = {};

  if ("theme" in record && record.theme !== undefined) {
    out.theme = asTheme(record.theme);
  }
  if ("useAppBlossomServers" in record && record.useAppBlossomServers !== undefined) {
    out.useAppBlossomServers = asBoolean(record.useAppBlossomServers, "useAppBlossomServers");
  }
  if ("relayMetadata" in record && record.relayMetadata !== undefined) {
    out.relayMetadata = parseRelayMetadata(record.relayMetadata);
  }
  if ("blossomServerMetadata" in record && record.blossomServerMetadata !== undefined) {
    out.blossomServerMetadata = parseBlossom(record.blossomServerMetadata);
  }
  return out;
}

function parseRelayMetadata(value: unknown): RelayMetadata {
  const record = asRecord(value, "relayMetadata");
  if (!Array.isArray(record.relays)) throw new Error("relayMetadata.relays must be an array");
  return {
    relays: record.relays.map((item, i) => {
      const relay = asRecord(item, `relayMetadata.relays[${i}]`);
      return {
        url: asUrl(relay.url, `relayMetadata.relays[${i}].url`),
        read: asBoolean(relay.read, `relayMetadata.relays[${i}].read`),
        write: asBoolean(relay.write, `relayMetadata.relays[${i}].write`),
      };
    }),
    updatedAt: asFiniteNumber(record.updatedAt, "relayMetadata.updatedAt"),
  };
}

function parseBlossom(value: unknown): BlossomServerMetadata {
  const record = asRecord(value, "blossomServerMetadata");
  if (!Array.isArray(record.servers)) {
    throw new Error("blossomServerMetadata.servers must be an array");
  }
  return {
    servers: record.servers.map((item, i) => asUrl(item, `blossomServerMetadata.servers[${i}]`)),
    updatedAt: asFiniteNumber(record.updatedAt, "blossomServerMetadata.updatedAt"),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asTheme(value: unknown): Theme {
  if (value === "dark" || value === "light" || value === "system") return value;
  throw new Error("Invalid theme");
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function asFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function asUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a URL`);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "wss:" && url.protocol !== "ws:") {
      throw new Error("unsupported protocol");
    }
    return value;
  } catch {
    throw new Error(`${label} must be an http(s) or ws(s) URL`);
  }
}
