/** Canonical wallet-balance helpers. Economic identity = SYMBOL@CONTRACT. */
import type { LeefSnapshot } from "@/lib/leef/types";
import type { UniverseToken } from "@/lib/leef/universe";
import { tokenPrice } from "@/lib/market/price-oracle";
import { canonicalTokenId } from "@/lib/market/stables";

export type BalanceBook = Record<string, number>;

export function balanceKey(symbol: string, contract: string): string {
  return canonicalTokenId(symbol, contract.toLowerCase());
}

function findBalanceValue(balances: BalanceBook, canonicalId: string): number | undefined {
  const exact = balances[canonicalId];
  if (exact != null) return exact;
  const wanted = canonicalId.toUpperCase();
  const hit = Object.keys(balances).find((key) => key.toUpperCase() === wanted);
  return hit ? balances[hit] : undefined;
}

/** Exact canonical amount; legacy bare-symbol fallback only when unambiguous. */
export function balanceAmount(
  balances: BalanceBook,
  token: Pick<UniverseToken, "symbol" | "contract">,
  universe?: UniverseToken[],
): number {
  const exact = findBalanceValue(balances, balanceKey(token.symbol, token.contract));
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
  if (identifier.includes("@")) {
    const at = identifier.indexOf("@");
    const id = balanceKey(identifier.slice(0, at), identifier.slice(at + 1));
    return findBalanceValue(balances, id) ?? 0;
  }
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
    const contract = row.contract.toLowerCase();
    out[balanceKey(symbol, contract)] = row.amount;
    const list = bySymbol.get(symbol) ?? [];
    list.push({ contract, amount: row.amount });
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

export type WalletBalanceRow = {
  /** Canonical key used for React identity and economic lookup. */
  id: string;
  symbol: string;
  contract: string | null;
  amount: number;
  token: UniverseToken | null;
};

/**
 * One display row per real asset. Canonical keys win; their bare aliases are
 * compatibility indexes and are never rendered as a second holding.
 * Unknown canonical Hyperion assets are still shown once with their contract.
 */
export function walletBalanceRows(
  balances: BalanceBook,
  universe: UniverseToken[],
  includeZeroIds: string[] = [],
): WalletBalanceRow[] {
  const rows = new Map<string, WalletBalanceRow>();
  const tokenById = new Map(
    universe.map((t) => [balanceKey(t.symbol, t.contract).toUpperCase(), t]),
  );
  const canonicalSymbols = new Set<string>();

  // Canonical entries first, including assets not yet priced in the universe.
  for (const [key, amount] of Object.entries(balances)) {
    const at = key.indexOf("@");
    if (at <= 0) continue;
    const symbol = key.slice(0, at).toUpperCase();
    const contract = key.slice(at + 1).toLowerCase();
    if (!symbol || !contract) continue;
    const id = balanceKey(symbol, contract);
    const token = tokenById.get(id.toUpperCase()) ?? null;
    rows.set(id.toUpperCase(), { id, symbol, contract, amount, token });
    canonicalSymbols.add(symbol);
  }

  // Legacy/paper bare symbols only when no canonical key already represents
  // that symbol. Resolve a contract only when the universe is unambiguous.
  for (const [key, amount] of Object.entries(balances)) {
    if (key.includes("@")) continue;
    const symbol = key.toUpperCase();
    if (canonicalSymbols.has(symbol)) continue;
    const matches = universe.filter((t) => t.symbol === symbol);
    const token = matches.length === 1 ? matches[0]! : null;
    const id = token ? balanceKey(token.symbol, token.contract) : symbol;
    rows.set(id.toUpperCase(), {
      id,
      symbol,
      contract: token?.contract ?? null,
      amount,
      token,
    });
  }

  for (const identifier of includeZeroIds) {
    const token = universe.find(
      (t) =>
        t.alcorId === identifier.toLowerCase() ||
        balanceKey(t.symbol, t.contract).toUpperCase() === identifier.toUpperCase() ||
        t.symbol === identifier.toUpperCase(),
    );
    if (!token) continue;
    const id = balanceKey(token.symbol, token.contract);
    if (!rows.has(id.toUpperCase())) {
      rows.set(id.toUpperCase(), {
        id,
        symbol: token.symbol,
        contract: token.contract,
        amount: 0,
        token,
      });
    }
  }

  return [...rows.values()];
}

export type PortfolioMark = {
  totalUsd: number;
  pricedUsd: number;
  unpriced: string[];
  assets: { id: string; amount: number; priceUsd: number; usd: number }[];
};

/** One oracle and one canonical balance book = one true portfolio mark. */
export function markPortfolioUsd(snap: LeefSnapshot, balances: BalanceBook): PortfolioMark {
  const assets: PortfolioMark["assets"] = [];
  const unpriced: string[] = [];
  for (const row of walletBalanceRows(balances, snap.universe)) {
    if (!(row.amount > 0)) continue;
    const price = tokenPrice(snap, row.id);
    if (!price || !(price.priceUsd > 0)) {
      unpriced.push(row.id);
      continue;
    }
    assets.push({
      id: row.id,
      amount: row.amount,
      priceUsd: price.priceUsd,
      usd: row.amount * price.priceUsd,
    });
  }
  const pricedUsd = assets.reduce((sum, asset) => sum + asset.usd, 0);
  return { totalUsd: pricedUsd, pricedUsd, unpriced, assets };
}
