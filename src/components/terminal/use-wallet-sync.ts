import { useEffect, useRef } from "react";
import { compareAllRoutes } from "@/lib/leef/amm";
import type { LeefSnapshot } from "@/lib/leef/types";
import { accountResources, fetchBalances } from "@/lib/wallet/chain";
import { evaluateClip } from "@/lib/wallet/decide";
import { hasSecret } from "@/lib/wallet/secret";
import { signAndPushSwap } from "@/lib/wallet/sign";
import { tokenCatalog } from "@/lib/wallet/tokens";
import { useWallet } from "@/store/wallet";
import { toast } from "@/hooks/useToast";

export function useWalletSync(snap: LeefSnapshot) {
  const fetchedAt = snap.fetchedAt;
  const mode = useWallet((s) => s.mode);
  const account = useWallet((s) => s.account);
  const autoOn = useWallet((s) => s.auto.enabled);
  const busy = useRef(false);
  const lastSnap = useRef("");

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

  useEffect(() => {
    if (!autoOn) {
      lastSnap.current = "";
      return;
    }
    if (lastSnap.current === fetchedAt) return;
    lastSnap.current = fetchedAt;
    if (busy.current) return;
    busy.current = true;
    void runClip(snap).finally(() => {
      busy.current = false;
    });
  }, [fetchedAt, autoOn, snap]);
}

export async function runClip(snap: LeefSnapshot, opts?: { force?: boolean }) {
  const w = useWallet.getState();
  const amount = Number(w.auto.amountIn) || 0;
  const routes = compareAllRoutes(
    snap.pools,
    snap.aux,
    amount,
    w.auto.tokenIn,
    w.auto.tokenOut,
  );
  const verdict = evaluateClip({
    enabled: w.auto.enabled,
    armed: w.auto.armed,
    mode: w.mode,
    hasKey: hasSecret() && w.mode === "live",
    tokenIn: w.auto.tokenIn,
    tokenOut: w.auto.tokenOut,
    amountIn: amount,
    routes,
    balances: w.balances(),
    minEdgePct: w.auto.minEdgePct,
    maxImpactPct: w.auto.maxImpactPct,
    maxEdgePct: w.auto.maxEdgePct,
    cooldownUntil: w.cooldownUntil,
    clipsThisHour: w.clipsThisHour,
    maxClipsHour: w.auto.maxClipsHour,
    now: Date.now(),
    force: opts?.force,
  });
  w.setLastVerdict(verdict.reason);
  if (!verdict.ok || !verdict.route) {
    if (opts?.force) toast({ title: verdict.reason });
    return;
  }

  const route = verdict.route;
  const minOut = route.amountOut * (1 - w.auto.slippage / 100);

  if (verdict.action === "paper") {
    w.applyPaperFill(route.tokenIn, amount, route.tokenOut, minOut);
    w.markClip(w.auto.cooldownSec);
    w.pushLog({
      mode: "paper",
      status: "filled",
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
      amountIn: amount,
      amountOut: minOut,
      routeLabel: route.label,
      poolIds: route.poolIds,
      reason: verdict.reason,
      edgePct: verdict.edgePct,
    });
    toast({ title: `Paper fill · ${route.label}` });
    return;
  }

  try {
    const exec = await signAndPushSwap({
      account: w.account,
      permission: w.permission,
      route,
      amountIn: amount,
      slippagePct: w.auto.slippage,
      snap,
    });
    w.markClip(w.auto.cooldownSec);
    w.pushLog({
      mode: "live",
      status: "filled",
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
      amountIn: amount,
      amountOut: exec.expectedOut,
      routeLabel:
        exec.routeSource === "alcor" ? `${route.label} · Alcor router` : route.label,
      poolIds: route.poolIds,
      reason: verdict.reason,
      txid: exec.txid,
      edgePct: verdict.edgePct,
    });
    toast({
      title: `Broadcast ${exec.txid.slice(0, 8)}…`,
      description: "Signed locally, pushed to the WAX chain.",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Broadcast failed";
    w.pushLog({
      mode: "live",
      status: "failed",
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
      amountIn: amount,
      amountOut: 0,
      routeLabel: route.label,
      poolIds: route.poolIds,
      reason: msg,
      edgePct: verdict.edgePct,
    });
    w.setLastVerdict(msg);
    toast({ title: "Swap failed", description: msg, variant: "destructive" });
  }
}
