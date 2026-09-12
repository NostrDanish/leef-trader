/** Canonical wallet-balance helpers. Economic identity = SYMBOL@CONTRACT. */
import type { UniverseToken } from "@/lib/leef/universe";
import { canonicalTokenId } from "@/lib/market/stables";

export type BalanceBook = Record<string, number>;

export function balanceKey(symbol: string, contract: string): string {
  return canonicalTokenId(symbol, contract);
}

/** Exact canonical amount; legacy bare-symbol fallback only when unambiguous. */
export function balanceAmount(
  balances: BalanceBook,
  token: Pick<UniverseToken, "symbol" | "contract">,
  universe?: UniverseToken[],
): number {
  const exact = balances[balanceKey(token.symbol, token.contract)];
  if (exact != null) return exact;
  const matches = universe?.filter((t) => t.symbol === token.symbol) ?? [token];
  return matches.length === 1 ? (balances[token.symbol] ?? 0) : 0;
}

/** Resolve an identifier to a balance without merging same-symbol contracts. */
export function balanceForIdentifier(
  balances: BalanceBook,
  universe: UniverseToken[],
  identifier: string,
): number {
  const up = identifier.toUpperCase();
  if (identifier.includes("@")) return balances[up] ?? 0;
  const exactAlcor = universe.find((t) => t.alcorId === identifier.toLowerCase());
  if (exactAlcor) return balanceAmount(balances, exactAlcor, universe);
  const matches = universe.filter((t) => t.symbol === up);
  if (matches.length !== 1) return 0;
  return balanceAmount(balances, matches[0]!, universe);
}

/**
 * Convert Hyperion token rows into a canonical balance book. Bare-symbol
 * aliases are added only for symbols with exactly one held contract, keeping
 * old UI/strategy code compatible without collapsing ambiguous assets.
 */
export function canonicalBalanceBook(
  rows: { symbol: string; contract: string; amount: number }[],
): BalanceBook {
  const out: BalanceBook = {};
  const bySymbol = new Map<string, { contract: string; amount: number }[]>();
  for (const row of rows) {
    const symbol = row.symbol.toUpperCase();
    out[balanceKey(symbol, row.contract)] = row.amount;
    const list = bySymbol.get(symbol) ?? [];
    list.push({ contract: row.contract, amount: row.amount });
    bySymbol.set(symbol, list);
  }
  for (const [symbol, list] of bySymbol) {
    if (list.length === 1) out[symbol] = list[0]!.amount;
  }
  return out;
}

/** Canonical entries only; legacy aliases are omitted to prevent double value. */
export function canonicalBalanceEntries(
  balances: BalanceBook,
  universe: UniverseToken[],
): { token: UniverseToken; amount: number }[] {
  const out: { token: UniverseToken; amount: number }[] = [];
  const seen = new Set<string>();
  for (const token of universe) {
    const id = balanceKey(token.symbol, token.contract);
    if (seen.has(id)) continue;
    const amount = balanceAmount(balances, token, universe);
    if (amount > 0) out.push({ token, amount });
    seen.add(id);
  }
  return out;
}
