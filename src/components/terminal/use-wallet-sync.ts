import { useEffect } from "react";
import type { LeefSnapshot } from "@/lib/leef/types";
import { accountResources, fetchBalances } from "@/lib/wallet/chain";
import { hasSecret } from "@/lib/wallet/secret";
import { tokenCatalog } from "@/lib/wallet/tokens";
import { useWallet } from "@/store/wallet";

/** Keeps live on-chain balances + resources in sync on each snapshot pull. */
export function useWalletSync(snap: LeefSnapshot) {
  const fetchedAt = snap.fetchedAt;
  const mode = useWallet((s) => s.mode);
  const account = useWallet((s) => s.account);

  useEffect(() => {
    if (mode !== "live" || !account || !hasSecret()) return;
    let cancelled = false;
    const tokens = tokenCatalog(snap).slice(0, 12);
    void (async () => {
      try {
        const [bal, res] = await Promise.all([
          fetchBalances(account, tokens),
          accountResources(account).catch(() => ({
            name: account,
            cpuPct: null,
            netPct: null,
          })),
        ]);
        if (cancelled) return;
        useWallet.getState().setLiveBalances(bal, res);
      } catch {
        /* keep last live book */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, account, fetchedAt, snap]);
}
