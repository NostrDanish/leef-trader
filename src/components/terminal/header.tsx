import { ArrowUpRight, KeyRound, RefreshCw } from "lucide-react";
import { LoginArea } from "@/components/auth/LoginArea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { marketStats } from "@/lib/leef/analytics";
import { fmtNum, fmtUsd } from "@/lib/leef/format";
import type { LeefSnapshot } from "@/lib/leef/types";
import { cn } from "@/lib/utils";
import { useBot } from "@/store/bot";
import { useTerminal } from "@/store/terminal";
import { useWallet } from "@/store/wallet";
import { TokenMark } from "./token-mark";

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
  const waxPerM = snap.waxPerLeef * 1_000_000;
  const chg = stats.change24;
  const mode = useWallet((s) => s.mode);
  const account = useWallet((s) => s.account);
  const botRunning = useBot((s) => s.running);
  const setTab = useTerminal((s) => s.setTab);
  const setImportOpen = useWallet((s) => s.setImportOpen);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex -space-x-2">
            <TokenMark symbol="LEEF" />
            <TokenMark symbol="WAX" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-medium tracking-tight">
                LEEF Analytics
              </h1>
              <Badge variant={snap.source === "live" ? "leef" : "warn"}>
                {snap.source === "live" ? "On-chain" : "Cached book"}
              </Badge>
            </div>
            <p className="hidden text-xs text-muted-foreground sm:block">
              AI bot + Alcor AMM desks for LEEF · leefmaincorp
            </p>
          </div>
        </div>

        <div className="hidden items-center gap-5 rounded-lg border border-border bg-surface px-4 py-2 text-xs md:flex">
          <div>
            <div className="text-subtle">1M LEEF</div>
            <div className="font-mono tabular-nums text-wax">
              {fmtNum(waxPerM, { digits: 2 })} WAX
            </div>
          </div>
          <div className="h-6 w-px bg-border" />
          <div>
            <div className="text-subtle">LEEF</div>
            <div className="font-mono tabular-nums">{fmtUsd(snap.leefUsd, 8)}</div>
          </div>
          <div className="h-6 w-px bg-border" />
          <div>
            <div className="text-subtle">24h</div>
            <div
              className={cn(
                "font-mono tabular-nums",
                chg == null ? "text-muted-foreground" : chg >= 0 ? "text-buy" : "text-sell",
              )}
            >
              {chg == null ? "—" : `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`}
            </div>
          </div>
          <div className="h-6 w-px bg-border" />
          <div>
            <div className="text-subtle">TVL</div>
            <div className="font-mono tabular-nums text-accent">
              {fmtUsd(stats.tvlUsd, 0)}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="hidden sm:inline-flex"
            onClick={() => setTab("wallet")}
          >
            <KeyRound className="size-3.5" />
            <span className="font-mono">{account}</span>
            <Badge
              variant={
                mode === "live" ? (botRunning ? "leef" : "plain") : botRunning ? "accent" : "plain"
              }
            >
              {mode === "live" ? (botRunning ? "Live bot" : "Key") : botRunning ? "Paper bot" : "Wallet"}
            </Badge>
          </Button>
          <Button
            variant="secondary"
            size="icon"
            className="sm:hidden"
            aria-label="Wallet"
            onClick={() => (mode === "live" ? setTab("wallet") : setImportOpen(true))}
          >
            <KeyRound />
          </Button>
          <Button
            variant="secondary"
            size="icon"
            onClick={onRefresh}
            aria-label="Refresh pools"
          >
            <RefreshCw className={fetching ? "animate-spin" : ""} />
          </Button>
          <Button variant="outline" size="sm" asChild className="hidden sm:inline-flex">
            <a
              href="https://wax.alcor.exchange/swap?output=LEEF-leefmaincorp&input=WAX-eosio.token"
              target="_blank"
              rel="noreferrer"
            >
              Trade on Alcor
              <ArrowUpRight className="size-3.5" />
            </a>
          </Button>
          <LoginArea className="hidden max-w-36 md:inline-flex" />
        </div>
      </div>
    </header>
  );
}