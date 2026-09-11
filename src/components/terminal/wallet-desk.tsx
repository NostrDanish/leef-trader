import { KeyRound, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { bestExecutionRoute } from "@/lib/leef/route-optimizer";
import { fmtNum, fmtUsd } from "@/lib/leef/format";
import type { LeefSnapshot } from "@/lib/leef/types";
import { findToken } from "@/lib/leef/universe";
import { tokenCatalog } from "@/lib/wallet/tokens";
import { useBot } from "@/store/bot";
import { useTerminal } from "@/store/terminal";
import { useWallet } from "@/store/wallet";
import { PairMarks } from "./token-mark";

function markUsd(symbol: string, qty: number, snap: LeefSnapshot): number {
  // Priced universe first — it covers every liquid token on Alcor.
  const u = findToken(snap.universe, symbol);
  if (u && u.usdPrice > 0) return qty * u.usdPrice;
  if (symbol === "WAX") return qty * snap.waxUsd;
  if (symbol === "LEEF") return qty * snap.leefUsd;
  if (symbol === "USDT" || symbol === "WAXUSDC" || symbol === "WAXUSDT") return qty;
  const pool = snap.pools.find((p) => p.pair.symbol.toUpperCase() === symbol);
  if (pool?.usdPerLeef && pool.pairPerLeef > 0) {
    return qty * (pool.usdPerLeef / pool.pairPerLeef);
  }
  return 0;
}

export function WalletDesk({ snap }: { snap: LeefSnapshot }) {
  const mode = useWallet((s) => s.mode);
  const account = useWallet((s) => s.account);
  const authType = useWallet((s) => s.authType);
  const cpuPct = useWallet((s) => s.cpuPct);
  const netPct = useWallet((s) => s.netPct);
  const hint = useWallet((s) => s.liveAccountHint);
  const setImportOpen = useWallet((s) => s.setImportOpen);
  const forgetLive = useWallet((s) => s.forgetLive);
  const resetPaper = useWallet((s) => s.resetPaper);
  const setTab = useTerminal((s) => s.setTab);
  const setSwap = useTerminal((s) => s.setSwap);
  const paperBalances = useWallet((s) => s.paperBalances);
  const liveBalances = useWallet((s) => s.liveBalances);
  const balances = mode === "live" ? liveBalances : paperBalances;
  const catalog = tokenCatalog(snap);
  const catalogSyms = new Set(catalog.map((t) => t.symbol));
  const rows = [
    ...catalog.map((t) => ({ symbol: t.symbol, qty: balances[t.symbol] ?? 0 })),
    // Anything else the wallet holds (Hyperion full scan / paper dust).
    ...Object.keys(balances)
      .filter((s) => !catalogSyms.has(s))
      .map((s) => ({ symbol: s, qty: balances[s] ?? 0 })),
  ]
    .map((t) => ({ ...t, usd: markUsd(t.symbol, t.qty, snap) }))
    .filter((t) => t.qty > 0 || t.symbol === "WAX" || t.symbol === "LEEF")
    .sort((a, b) => b.usd - a.usd || b.qty - a.qty);

  const wax = balances.WAX ?? 0;
  const leef = balances.LEEF ?? 0;
  const buySize = Math.min(10, wax) || 10;
  const sellSize = Math.min(1_000_000, leef) || 1_000_000;
  const buy = bestExecutionRoute(snap.pools, snap.aux, buySize, "WAX", "LEEF");
  const sell = bestExecutionRoute(snap.pools, snap.aux, sellSize, "LEEF", "WAX");

  function sendToBot(kind: "buy" | "sell", amountIn: number) {
    if (kind === "buy") {
      useBot.getState().setRisk({ clipWax: Math.max(0.1, amountIn) });
    }
    setSwap({
      tokenIn: kind === "buy" ? "WAX" : "LEEF",
      tokenOut: kind === "buy" ? "LEEF" : "WAX",
      amountIn: String(amountIn),
    });
    setTab("bot");
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-base font-medium tracking-tight">Wallet</h2>
          <p className="text-xs text-muted-foreground">
            Holdings vs the 30s routed book.{" "}
            {authType === "key" || !authType
              ? "Keys stay in this tab — never on a server."
              : "Signed by your wallet — keys never touch this app."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <KeyRound className="size-3.5" />
            Connect wallet
          </Button>
          {mode === "live" ? (
            <Button variant="danger" size="sm" onClick={forgetLive}>
              <Trash2 className="size-3.5" />
              Disconnect
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={resetPaper}>
              Reset paper book
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="border-l-2 border-l-accent p-4">
          <div className="text-xs uppercase tracking-wider text-subtle">Session</div>
          <div className="mt-1 font-mono text-lg">{account}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge variant={mode === "live" ? "leef" : "warn"}>
              {mode === "live"
                ? authType === "key"
                  ? "Live key"
                  : authType === "wcw"
                    ? "Cloud Wallet"
                    : "Anchor"
                : "Paper"}
            </Badge>
            {hint && mode === "paper" && (
              <Badge variant="plain">Reconnect for {hint}</Badge>
            )}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase tracking-wider text-subtle">WAX</div>
          <div className="mt-1 font-mono text-lg tabular-nums">
            {fmtNum(wax, { digits: 4 })}
          </div>
          <div className="text-xs text-muted-foreground">{fmtUsd(wax * snap.waxUsd, 4)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase tracking-wider text-subtle">LEEF</div>
          <div className="mt-1 font-mono text-lg tabular-nums text-leef">
            {fmtNum(leef, { compact: true })}
          </div>
          <div className="text-xs text-muted-foreground">{fmtUsd(leef * snap.leefUsd, 4)}</div>
          {mode === "live" && cpuPct != null && (
            <div className="mt-3 border-t border-border pt-2 font-mono text-xs text-subtle">
              CPU {(cpuPct * 100).toFixed(0)}%
              {netPct != null ? ` · NET ${(netPct * 100).toFixed(0)}%` : ""}
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4 sm:p-5">
          <h3 className="text-sm font-medium">Best buy with WAX</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {buy
              ? `Swap on ${buy.label} · ${fmtNum(buy.amountOut, { compact: true })} LEEF for ${fmtNum(buySize)} WAX`
              : "No backed route"}
          </p>
          {buy && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => sendToBot("buy", buySize)}
            >
              Trade this with the bot
            </Button>
          )}
        </Card>
        <Card className="p-4 sm:p-5">
          <h3 className="text-sm font-medium">Best sell of LEEF</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {sell
              ? `Swap on ${sell.label} · ${fmtNum(sell.amountOut, { compact: true })} WAX for ${fmtNum(sellSize, { compact: true })} LEEF`
              : "No backed route"}
          </p>
          {sell && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => sendToBot("sell", sellSize)}
            >
              Trade this with the bot
            </Button>
          )}
        </Card>
      </div>

      <Card className="p-4 sm:p-5">
        <h3 className="mb-3 text-sm font-medium">Holdings</h3>
        <div className="-mx-4 min-w-0 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[420px] text-left text-xs">
            <thead className="text-subtle">
              <tr className="border-b border-border">
                <th className="py-2 pr-3 font-medium">Token</th>
                <th className="py-2 pr-3 font-medium">Balance</th>
                <th className="py-2 font-medium">USD</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol} className="border-b border-border/70">
                  <td className="py-2.5 pr-3">
                    <span className="flex items-center gap-2">
                      <PairMarks pair={r.symbol} />
                      <span className="font-mono">{r.symbol}</span>
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 font-mono tabular-nums">
                    {fmtNum(r.qty, { compact: true, digits: 4 })}
                  </td>
                  <td className="py-2.5 font-mono tabular-nums text-muted-foreground">
                    {r.usd > 0 ? fmtUsd(r.usd, 4) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {mode === "paper" && (
          <p className="mt-3 text-xs text-subtle">
            Paper starts with a simulated book so you can run the bot and the
            rebalancer risk-free. Connect Cloud Wallet / Anchor (sign per
            trade) or import a session key (fully automatic) to go live.
          </p>
        )}
      </Card>
    </div>
  );
}
