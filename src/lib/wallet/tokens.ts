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
  const key = (symbol: string, contract: string) => `${symbol.toUpperCase()}@${contract}`;
  for (const t of BASE) map.set(key(t.symbol, t.contract), t);
  const put = (symbol: string, contract: string, decimals: number) => {
    const s = symbol.toUpperCase();
    if (!s || !contract || map.has(key(s, contract))) return;
    map.set(key(s, contract), {
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
  identifier: string,
  snap?: Pick<LeefSnapshot, "pools" | "aux" | "universe">,
): TokenMeta {
  const raw = identifier.trim();
  const up = raw.toUpperCase();
  const catalog = tokenCatalog(snap);
  const exact =
    catalog.find((t) => t.alcorId === raw.toLowerCase()) ??
    catalog.find((t) => `${t.symbol}@${t.contract}`.toUpperCase() === up);
  if (exact) return exact;
  const matches = catalog.filter((t) => t.symbol === up);
  if (matches.length === 1) return matches[0]!;
  throw new Error(
    matches.length > 1
      ? `${up} is ambiguous — select SYMBOL@CONTRACT`
      : `Unknown token ${identifier} — contract identity required`,
  );
}

/**
 * Antelope asset string at exact token precision. Never scientific notation
 * (`1e-8 WAX` is an invalid amount on-chain). Truncates toward zero so we
 * never round *up* past the wallet balance.
 */
export function formatAsset(amount: number, token: TokenMeta): string {
  const decimals = Math.max(0, Math.min(18, token.decimals | 0));
  const scale = 10 ** decimals;
  const units = Math.floor(Math.max(0, amount) * scale + 1e-9);
  const whole = Math.floor(units / scale);
  const frac = units % scale;
  const body =
    decimals === 0 ? String(whole) : `${whole}.${String(frac).padStart(decimals, "0")}`;
  return `${body} ${token.symbol}`;
}

/** Decimal string Alcor's router expects — no exponent, exact precision. */
export function formatAmountParam(amount: number, decimals: number): string {
  const d = Math.max(0, Math.min(18, decimals | 0));
  const scale = 10 ** d;
  const units = Math.floor(Math.max(0, amount) * scale + 1e-9);
  const whole = Math.floor(units / scale);
  const frac = units % scale;
  return d === 0 ? String(whole) : `${whole}.${String(frac).padStart(d, "0")}`;
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
