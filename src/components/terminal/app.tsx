import { useEffect, useState } from "react";
import { restoreWallet } from "@/lib/wallet/session";
import { marketEngine } from "@/lib/market/market-engine";
import { useTerminal } from "@/store/terminal";
import { useWallet } from "@/store/wallet";
import { AiDesk } from "./ai-desk";
import { BotDesk } from "./bot-desk";
import { Dashboard } from "./dashboard";
import { Evidence } from "./evidence";
import { TerminalHeader } from "./header";
import { IlCalc } from "./il";
import { ImportKeyDialog } from "./import-key";
import { InfraStatus } from "./infra-status";
import { Overview } from "./overview";
import { PoolsTable } from "./pools";
import { PortfolioDesk } from "./portfolio-desk";
import { Quotes } from "./quotes";
import { DesktopNav, MobileNav } from "./shell-nav";
import { StatusBar } from "./status-bar";
import { Tape } from "./tape";
import { TickDesk } from "./tick";
import { useLiveTick } from "./use-live-tick";
import { useSnapshot } from "./use-snapshot";
import { WalletDesk } from "./wallet-desk";

export function TerminalApp() {
  const { snap, ranked, isFetching, refetch, dataUpdatedAt, syncSec } = useSnapshot();
  const tick = useLiveTick(snap);
  const tab = useTerminal((s) => s.tab);
  const [countdown, setCountdown] = useState(syncSec);

  // The persistent market engine: chain heartbeat, market pulls, on-chain
  // pool state, balances, bot + rebalancer drivers, suspension resync.
  // Started ONCE — it outlives every component (no refresh, ever).
  useEffect(() => {
    marketEngine.start();
  }, []);

  // Restore an external wallet session (Cloud Wallet / Anchor) on load.
  useEffect(() => {
    const authType = useWallet.getState().authType;
    if (authType !== "wcw" && authType !== "anchor") return;
    let cancelled = false;
    void restoreWallet().then((id) => {
      if (cancelled) return;
      if (id) useWallet.getState().setWalletSession(id);
      else useWallet.setState({ authType: null });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setCountdown(syncSec);
  }, [dataUpdatedAt, syncSec]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setCountdown((c) => (c <= 1 ? syncSec : c - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [syncSec]);

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-bg text-fg">
      <TerminalHeader
        snap={snap}
        fetching={isFetching}
        onRefresh={() => {
          void refetch();
        }}
      />
      <StatusBar snap={snap} ranked={ranked} countdown={countdown} tick={tick} />
      <ImportKeyDialog />

      {snap.warning && snap.source === "fallback" && (
        <div className="mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6">
          <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
            {snap.warning}
          </div>
        </div>
      )}

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 px-4 py-5 pb-24 sm:px-6 md:pb-5">
        <div className="min-w-0">
          <DesktopNav poolCount={snap.pools.length} />
        </div>
        <MobileNav poolCount={snap.pools.length} />

        {tab === "overview" && <Overview snap={snap} ranked={ranked} />}
        {tab === "pools" && <PoolsTable ranked={ranked} />}
        {tab === "pool" && <Dashboard snap={snap} />}
        {tab === "quotes" && <Quotes snap={snap} ranked={ranked} />}
        {tab === "tick" && <TickDesk snap={snap} tick={tick} />}
        {tab === "il" && <IlCalc snap={snap} />}
        {tab === "tape" && <Tape snap={snap} />}
        {tab === "wallet" && <WalletDesk snap={snap} />}
        {tab === "bot" && <BotDesk snap={snap} />}
        {tab === "portfolio" && <PortfolioDesk snap={snap} />}
        {tab === "evidence" && <Evidence />}
        {tab === "ai" && <AiDesk snap={snap} />}
        {tab === "infra" && <InfraStatus />}
      </main>

      <footer className="border-t border-border py-4 pb-24 text-xs text-subtle md:pb-4">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 px-4 sm:flex-row sm:px-6">
          <span>LEEF analytics · leefmaincorp · Alcor AMM on WAX</span>
          <div className="flex items-center gap-4">
            <a
              className="hover:text-fg"
              href="https://wax.alcor.exchange"
              target="_blank"
              rel="noreferrer"
            >
              Alcor
            </a>
            <a
              className="hover:text-fg"
              href="https://waxblock.io/tokens/LEEF-wax-leefmaincorp"
              target="_blank"
              rel="noreferrer"
            >
              Explorer
            </a>
            <a
              className="hover:text-fg"
              href="https://shakespeare.diy"
              target="_blank"
              rel="noreferrer"
            >
              Vibed with Shakespeare
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
