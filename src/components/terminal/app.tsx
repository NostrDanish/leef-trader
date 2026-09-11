import {
  Activity,
  Bot,
  Calculator,
  GitCompare,
  Layers,
  LayoutDashboard,
  LineChart,
  PieChart,
  Radio,
  Wallet,
} from "lucide-react";
import { useEffect, useState } from "react";
import { restoreWallet } from "@/lib/wallet/session";
import { cn } from "@/lib/utils";
import { type TabId, useTerminal } from "@/store/terminal";
import { useWallet } from "@/store/wallet";
import { BotDesk } from "./bot-desk";
import { Dashboard } from "./dashboard";
import { TerminalHeader } from "./header";
import { IlCalc } from "./il";
import { ImportKeyDialog } from "./import-key";
import { LiveStrip } from "./live-strip";
import { Overview } from "./overview";
import { PoolsTable } from "./pools";
import { PortfolioDesk } from "./portfolio-desk";
import { Quotes } from "./quotes";
import { StatusBar } from "./status-bar";
import { Tape } from "./tape";
import { TickDesk } from "./tick";
import { useBotLoop } from "./use-bot-loop";
import { useLiveTick } from "./use-live-tick";
import { usePortfolioLoop } from "./use-portfolio-loop";
import { useSnapshot } from "./use-snapshot";
import { useWalletSync } from "./use-wallet-sync";
import { WalletDesk } from "./wallet-desk";

const TABS: { id: TabId; label: string; icon: typeof GitCompare }[] = [
  { id: "tick", label: "Live tick", icon: Radio },
  { id: "bot", label: "AI Bot", icon: Bot },
  { id: "portfolio", label: "Portfolio", icon: PieChart },
  { id: "wallet", label: "Wallet", icon: Wallet },
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "pools", label: "Pools", icon: Layers },
  { id: "pool", label: "Pool desk", icon: LineChart },
  { id: "quotes", label: "Quotes", icon: GitCompare },
  { id: "il", label: "IL calc", icon: Calculator },
  { id: "tape", label: "Tape", icon: Activity },
];

export function TerminalApp() {
  const { snap, ranked, isFetching, refetch, dataUpdatedAt } = useSnapshot();
  const tick = useLiveTick(snap);
  useWalletSync(snap);
  useBotLoop(snap);
  usePortfolioLoop(snap);
  const tab = useTerminal((s) => s.tab);
  const setTab = useTerminal((s) => s.setTab);
  const [countdown, setCountdown] = useState(30);

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
    setCountdown(30);
  }, [dataUpdatedAt]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setCountdown((c) => (c <= 1 ? 30 : c - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <TerminalHeader
        snap={snap}
        fetching={isFetching}
        onRefresh={() => {
          void refetch();
        }}
      />
      <StatusBar snap={snap} ranked={ranked} countdown={countdown} />
      <LiveStrip tick={tick} />
      <ImportKeyDialog />

      {snap.warning && snap.source === "fallback" && (
        <div className="mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6">
          <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
            {snap.warning}
          </div>
        </div>
      )}

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 px-4 py-5 sm:px-6">
        <div className="flex items-center justify-between gap-3 border-b border-border">
          <nav
            className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:px-0"
            aria-label="Sections"
          >
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 text-xs font-medium transition-colors",
                    active
                      ? "bg-accent/10 text-accent border border-accent/30"
                      : "text-muted-foreground hover:bg-surface-2 hover:text-fg border border-transparent",
                  )}
                >
                  <Icon className="size-3.5" />
                  {t.label}
                  {t.id === "pools" && (
                    <span className="rounded-full bg-surface-3 px-1.5 font-mono text-accent">
                      {snap.pools.length}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

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
      </main>

      <footer className="border-t border-border py-4 text-xs text-subtle">
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