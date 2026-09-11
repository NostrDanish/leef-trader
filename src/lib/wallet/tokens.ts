import type { LeefSnapshot } from "@/lib/leef/types";

export type TokenMeta = {
  symbol: string;
  contract: string;
  decimals: number;
  alcorId: string;
};

const BASE: TokenMeta[] = [
  { symbol: "WAX", contract: "eosio.token", decimals: 8, alcorId: "wax-eosio.token" },
  { symbol: "LEEF", contract: "leefmaincorp", decimals: 4, alcorId: "leef-leefmaincorp" },
  { symbol: "USDT", contract: "usdt.alcor", decimals: 4, alcorId: "usdt-usdt.alcor" },
  { symbol: "WAXUSDC", contract: "eth.token", decimals: 6, alcorId: "waxusdc-eth.token" },
  { symbol: "WAXUSDT", contract: "eth.token", decimals: 6, alcorId: "waxusdt-eth.token" },
  { symbol: "PARAUSD", contract: "parareserves", decimals: 6, alcorId: "parausd-parareserves" },
];

export function tokenCatalog(snap?: Pick<LeefSnapshot, "pools">): TokenMeta[] {
  const map = new Map<string, TokenMeta>();
  for (const t of BASE) map.set(t.symbol, t);
  for (const p of snap?.pools ?? []) {
    const symbol = p.pair.symbol.toUpperCase();
    if (map.has(symbol)) continue;
    const contract = p.pair.contract || "eosio.token";
    map.set(symbol, {
      symbol,
      contract,
      decimals: p.pair.decimals || 4,
      alcorId: `${symbol.toLowerCase()}-${contract}`,
    });
  }
  return [...map.values()];
}

export function metaOf(symbol: string, snap?: Pick<LeefSnapshot, "pools">): TokenMeta {
  const s = symbol.toUpperCase();
  return tokenCatalog(snap).find((t) => t.symbol === s) ?? {
    symbol: s,
    contract: "eosio.token",
    decimals: 4,
    alcorId: `${s.toLowerCase()}-eosio.token`,
  };
}

export function formatAsset(amount: number, token: TokenMeta): string {
  const n = Math.max(0, amount);
  return `${n.toFixed(token.decimals)} ${token.symbol}`;
}

export function parseAsset(raw: string): { amount: number; symbol: string } | null {
  const m = String(raw).trim().match(/^([\d.]+)\s+([A-Z0-9]+)$/);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount)) return null;
  return { amount, symbol: m[2]! };
}

export function isAccountName(s: string): boolean {
  return /^[a-z1-5.]{1,13}$/.test(s.trim()) && !s.startsWith(".") && !s.endsWith(".");
}
