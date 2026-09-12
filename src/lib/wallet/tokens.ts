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

export function tokenCatalog(
  snap?: Pick<LeefSnapshot, "pools" | "aux" | "universe">,
): TokenMeta[] {
  const map = new Map<string, TokenMeta>();
  for (const t of BASE) map.set(t.symbol, t);
  const put = (symbol: string, contract: string, decimals: number) => {
    const s = symbol.toUpperCase();
    if (!s || !contract || map.has(s)) return;
    map.set(s, {
      symbol: s,
      contract,
      decimals: decimals || 4,
      alcorId: `${s.toLowerCase()}-${contract}`,
    });
  };
  for (const p of snap?.pools ?? []) {
    put(p.pair.symbol, p.pair.contract, p.pair.decimals);
    put(p.leef.symbol, p.leef.contract, p.leef.decimals);
  }
  for (const p of snap?.aux ?? []) {
    put(p.tokenA.symbol, p.tokenA.contract, p.tokenA.decimals);
    put(p.tokenB.symbol, p.tokenB.contract, p.tokenB.decimals);
  }
  for (const u of snap?.universe ?? []) {
    put(u.symbol, u.contract, u.decimals);
  }
  return [...map.values()];
}

export function metaOf(
  symbol: string,
  snap?: Pick<LeefSnapshot, "pools" | "aux" | "universe">,
): TokenMeta {
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
