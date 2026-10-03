import { ArrowUpRight, RefreshCw, ShieldAlert, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import { LazyLoginArea } from "@/components/auth/LazyLoginArea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { marketStats } from "@/lib/leef/analytics";
import { fmtNum, fmtUsd } from "@/lib/leef/format";
import type { LeefSnapshot } from "@/lib/leef/types";
import { toast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";
import { useBot } from "@/store/bot";
import { usePortfolio } from "@/store/portfolio";
import { useTerminal } from "@/store/terminal";
import { useWallet } from "@/store/wallet";
import { TokenMark } from "./token-mark";

/**
 * Emergency stop: halts the bot AND the rebalancer immediately. Open
 * positions are left untouched (nothing is sold); restarting is a deliberate
 * manual action from each desk. An in-tab session key is dropped and its
 * bytes zeroized (re-import it to trade again); Cloud Wallet / Anchor
 * sessions stay connected — they hold no key in this tab.
 */
function emergencyStopAll() {
  const botWasRunning = useBot.getState().running;
  const rebalWasRunning = usePortfolio.getState().running;
  useBot.getState().stop("Emergency stop — automation halted");
  usePortfolio.getState().stop();
  const keyDropped = useWallet.getState().forgetSessionKey();
  const base =
    botWasRunning || rebalWasRunning
      ? "All automation halted. Open positions were NOT closed — manage them from the Bot desk."
      : "Nothing was running.";
  toast({
    title: "Emergency stop",
    description: keyDropped ? `${base} Session key forgotten — re-import it to trade.` : base,
    variant: "destructive",
  });
}

export function TerminalHeader({
  snap,
  fetching,
  onRefresh,
}: {
  snap: LeefSnapshot;
  fetching: boolean;
  onRefresh: () => void;
}) {
  const stats = marketStats(snap);
  const chg = stats.change24;
  const mode = useWallet((s) => s.mode);
  const account = useWallet((s) => s.account);
  const authType = useWallet((s) => s.authType);
  const botRunning = useBot((s) => s.running);
  const rebalRunning = usePortfolio((s) => s.running);
  const setTab = useTerminal((s) => s.setTab);
  const setImportOpen = useWallet((s) => s.setImportOpen);

  const chgPos = chg != null && chg >= 0;

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-bg/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-3 px-4 sm:px-6">
        {/* Brand */}
        <button
          type="button"
          onClick={() => setTab("overview")}
          className="flex min-w-0 items-center gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label="Go to overview"
        >
          <span className="grid size-9 place-items-center rounded-xl bg-leef/15 ring-1 ring-leef/30">
            <TokenMark symbol="LEEF" size="sm" />
          </span>
          <span className="flex flex-col items-start leading-none">
            <span className="text-sm font-semibold tracking-tight">LEEF Trader</span>
            <span className="mt-1 hidden text-[11px] text-subtle sm:block">
              Alcor AMM · WAX
            </span>
          </span>
          <Badge
            variant={snap.source === "live" ? "leef" : "warn"}
            className="ml-1 hidden md:inline-flex"
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                snap.source === "live" ? "animate-pulse bg-leef" : "bg-warn",
              )}
            />
            {snap.source === "live" ? "Live" : "Cached"}
          </Badge>
        </button>

        {/* Market stats pill */}
        <div className="hidden items-center rounded-full border border-border/70 bg-surface/80 px-2 py-1.5 text-xs shadow-[0_1px_0_0_rgb(255_255_255/0.03)_inset] lg:flex">
          <div className="flex items-center gap-2 px-3">
            <span className="text-subtle">LEEF</span>
            <span className="font-mono text-sm font-medium tabular-nums">
              {fmtUsd(snap.leefUsd)}
            </span>
            <span
              className={cn(
                "flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono tabular-nums",
                chg == null
                  ? "text-muted-foreground"
                  : chgPos
                    ? "bg-buy/10 text-buy"
                    : "bg-sell/10 text-sell",
              )}
            >
              {chg != null && (chgPos ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />)}
              {chg == null ? "—" : `${chgPos ? "+" : ""}${chg.toFixed(2)}%`}
            </span>
          </div>
          <div className="h-5 w-px bg-border" />
          <div className="hidden px-3 xl:block">
            <span className="text-subtle">TVL </span>
            <span className="font-mono tabular-nums text-fg">{fmtUsd(stats.tvlUsd, 0)}</span>
          </div>
          <div className="hidden h-5 w-px bg-border xl:block" />
          <div className="hidden px-3 xl:block">
            <span className="text-subtle">24h </span>
            <span className="font-mono tabular-nums text-fg">{fmtUsd(stats.volume24Usd, 0)}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {(botRunning || rebalRunning) && (
            <Button
              variant="danger"
              size="sm"
              onClick={emergencyStopAll}
              aria-label="Emergency stop — halt the bot and the rebalancer"
              title="Emergency stop — halt all automation (positions stay open)"
            >
              <ShieldAlert className="size-3.5" />
              <span className="hidden md:inline">Stop all</span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={onRefresh}
            aria-label="Refresh pools"
            className="text-muted-foreground hover:text-fg"
          >
            <RefreshCw className={fetching ? "animate-spin" : ""} />
          </Button>
          <Button
            variant="outline"
            size="icon"
            asChild
            className="hidden sm:inline-flex"
            title="Trade on Alcor"
          >
            <a
              href="https://wax.alcor.exchange/swap?output=LEEF-leefmaincorp&input=WAX-eosio.token"
              target="_blank"
              rel="noreferrer"
              aria-label="Trade on Alcor"
            >
              <ArrowUpRight className="size-4" />
            </a>
          </Button>
          <Button
            variant={mode === "live" ? "secondary" : "default"}
            size="sm"
            className="hidden sm:inline-flex"
            onClick={() => setTab("wallet")}
          >
            <Wallet className="size-3.5" />
            <span className="font-mono">{account}</span>
            {mode === "live" && (
              <Badge variant={botRunning ? "leef" : "plain"}>
                {botRunning
                  ? "Live bot"
                  : authType === "key"
                    ? "Key"
                    : authType === "wcw"
                      ? "WCW"
                      : "Anchor"}
              </Badge>
            )}
            {mode !== "live" && botRunning && <Badge variant="accent">Paper bot</Badge>}
          </Button>
          <Button
            variant="default"
            size="icon"
            className="sm:hidden"
            aria-label="Wallet"
            onClick={() => (mode === "live" ? setTab("wallet") : setImportOpen(true))}
          >
            <Wallet />
          </Button>
          <LazyLoginArea className="hidden max-w-36 xl:inline-flex" />
        </div>
      </div>
    </header>
  );
}
