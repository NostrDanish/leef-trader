import type { LeefSnapshot } from "@/lib/leef/types";
import { accountResources, fetchAllBalances } from "@/lib/wallet/chain";
import { tokenCatalog } from "@/lib/wallet/tokens";
import { canonicalBalanceBook } from "@/lib/wallet/balances";
import { useWallet } from "@/store/wallet";

/**
 * Live on-chain balance + resource sync (plain function — driven by the
 * MarketEngine on every cycle, after trades, and on browser resume).
 * Uses Hyperion's get_tokens so EVERY held token shows up (the rebalancer
 * needs the full picture), with a per-token RPC fallback.
 *
 * The imported signing session is NEVER touched here: market and balance
 * refreshes must not recreate the signer.
 */
export async function syncWalletBalances(snap: LeefSnapshot): Promise<void> {
  const w = useWallet.getState();
  if (w.mode !== "live" || !w.account || !w.canSign()) return;
  const known = tokenCatalog(snap).slice(0, 12);
  try {
    const [all, res] = await Promise.all([
      fetchAllBalances(w.account, known),
      accountResources(w.account).catch(() => ({
        name: w.account,
        cpuPct: null,
        netPct: null,
        ramPct: null,
      })),
    ]);
    // Preserve every contract under SYMBOL@CONTRACT. A bare-symbol alias is
    // emitted only when exactly one held contract owns that symbol, so cloned
    // USDT/WAXUSDC assets can never overwrite one another.
    const bal = canonicalBalanceBook(all);
    useWallet.getState().setLiveBalances(bal, res);
  } catch {
    /* keep last live book */
  }
}
