import { useEffect } from "react";
import type { LeefSnapshot } from "@/lib/leef/types";
import { accountResources, fetchAllBalances } from "@/lib/wallet/chain";
import { tokenCatalog } from "@/lib/wallet/tokens";
import { useWallet } from "@/store/wallet";

/**
 * Keeps live on-chain balances + resources in sync on each snapshot pull.
 * Uses Hyperion's get_tokens so EVERY held token shows up (the rebalancer
 * needs the full picture), with a per-token RPC fallback.
 */
export function useWalletSync(snap: LeefSnapshot) {
  const fetchedAt = snap.fetchedAt;
  const mode = useWallet((s) => s.mode);
  const account = useWallet((s) => s.account);
  const authType = useWallet((s) => s.authType);

  useEffect(() => {
    if (mode !== "live" || !account || !useWallet.getState().canSign()) return;
    let cancelled = false;
    const known = tokenCatalog(snap).slice(0, 12);
    void (async () => {
      try {
        const [all, res] = await Promise.all([
          fetchAllBalances(account, known),
          accountResources(account).catch(() => ({
            name: account,
            cpuPct: null,
            netPct: null,
            ramPct: null,
          })),
        ]);
        if (cancelled) return;
        const bal: Record<string, number> = {};
        for (const t of all) {
          const prev = bal[t.symbol];
          if (prev == null) {
            bal[t.symbol] = t.amount;
            continue;
          }
          // Scam tokens clone real symbols — the contract with a priced,
          // non-dust pool (the universe) wins the symbol slot.
          const inUniverse = snap.universe.some(
            (u) => u.symbol === t.symbol && u.contract === t.contract,
          );
          if (inUniverse) bal[t.symbol] = t.amount;
        }
        useWallet.getState().setLiveBalances(bal, res);
      } catch {
        /* keep last live book */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, account, authType, fetchedAt, snap]);
}
