import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { bestExecutionRoute } from "@/lib/leef/route-optimizer";
import { fmtNum, fmtUsd } from "@/lib/leef/format";
import type { LeefSnapshot } from "@/lib/leef/types";
import { tokenPrice } from "@/lib/market/price-oracle";
import { balanceForIdentifier, walletBalanceRows } from "@/lib/wallet/balances";
import { signAndPushStakeCpu } from "@/lib/wallet/sign";
import { toast } from "@/hooks/useToast";
import { useBot } from "@/store/bot";
import { useTerminal } from "@/store/terminal";
import { useWallet } from "@/store/wallet";
import { TokenMark } from "./token-mark";

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
  const rows = walletBalanceRows(balances, snap.universe, [
    "WAX@eosio.token",
    "LEEF@leefmaincorp",
  ])
    .map((row) => {
      const price = row.token ? tokenPrice(snap, row.id) : null;
      return { ...row, usd: price ? row.amount * price.priceUsd : 0 };
    })
    .filter((row) => row.amount > 0 || row.symbol === "WAX" || row.symbol === "LEEF")
    .sort((a, b) => b.usd - a.usd || b.amount - a.amount);

  const wax = balanceForIdentifier(balances, snap.universe, "WAX@eosio.token");
  const leef = balanceForIdentifier(balances, snap.universe, "LEEF@leefmaincorp");
  const buySize = Math.min(10, wax) || 10;
  const sellSize = Math.min(1_000_000, leef) || 1_000_000;
  const buy = bestExecutionRoute(snap.pools, snap.aux, buySize, "WAX", "LEEF");
  const sell = bestExecutionRoute(snap.pools, snap.aux, sellSize, "LEEF", "WAX");

  function sendToBot(kind: "buy" | "sell", amountIn: number) {
    if (kind === "buy") {
      useBot.getState().setRisk({
        minTradeUsd: Math.max(0.01, amountIn * (snap.waxUsd || 0)),
      });
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
              <Trash2 className="size-3.5" />
              Clear unsigned wallet
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
          <div className="text-xs text-muted-foreground">
            {fmtUsd(leef * snap.leefUsd)}
            {leef > 0 && (
              <span className="mt-0.5 block text-[10px] text-subtle">
                10M LEEF = {fmtNum(snap.waxPerLeef * 10_000_000, { digits: 4 })} WAX
              </span>
            )}
          </div>
          {mode === "live" && cpuPct != null && (
            <div className="mt-3 border-t border-border pt-2 font-mono text-xs text-subtle">
              CPU {(cpuPct * 100).toFixed(0)}%
              {netPct != null ? ` · NET ${(netPct * 100).toFixed(0)}%` : ""}
            </div>
          )}
          {mode === "live" && cpuPct != null && cpuPct > 0.6 && (
            <StakeCpu waxBalance={wax} cpuPct={cpuPct} />
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
                <tr key={r.id} className="border-b border-border/70">
                  <td className="py-2.5 pr-3">
                    <span className="flex items-center gap-2">
                      <TokenMark symbol={r.symbol} size="sm" />
                      <span>
                        <span className="block font-mono">{r.symbol}</span>
                        {r.contract && (
                          <span className="block font-mono text-[10px] text-subtle">
                            {r.contract}
                          </span>
                        )}
                      </span>
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 font-mono tabular-nums">
                    {fmtNum(r.amount, { compact: true, digits: 4 })}
                  </td>
                  <td className="py-2.5 font-mono tabular-nums text-muted-foreground">
                    {r.usd > 0 ? fmtUsd(r.usd) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {mode === "paper" && (
          <p className="mt-3 text-xs text-subtle">
            No simulated bag — this wallet is empty until you connect Cloud
            Wallet, Anchor, or a session key. The market book is live Alcor;
            fills only move tokens after you sign.
          </p>
        )}
      </Card>
    </div>
  );
}

/**
 * Stake WAX for CPU, recovered from the old trader's staking panel. The bot
 * pauses at 95% CPU — this is the in-app remedy. Goes through the policy
 * firewall like every action: self-stake only, never transfer=true.
 */
function StakeCpu({ waxBalance, cpuPct }: { waxBalance: number; cpuPct: number }) {
  const [amount, setAmount] = useState("5");
  const [busy, setBusy] = useState(false);
  const account = useWallet((s) => s.account);
  const permission = useWallet((s) => s.permission);
  const canSign = useWallet((s) => s.canSign());

  async function stake() {
    const amt = Number(amount);
    if (!(amt > 0) || amt > waxBalance || !canSign) return;
    setBusy(true);
    try {
      const { txid } = await signAndPushStakeCpu({ account, permission, waxAmount: amt });
      toast({
        title: `Staked ${amt.toFixed(4)} WAX for CPU`,
        description: `tx ${txid.slice(0, 10)}…`,
      });
    } catch (err) {
      toast({
        title: "Stake failed",
        description: err instanceof Error ? err.message : "unknown error",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-md border border-warn/30 bg-warn/10 p-2">
      <p className="mb-1.5 text-[11px] text-warn">
        CPU at {(cpuPct * 100).toFixed(0)}% — the bot pauses at 95%. Stake WAX to keep trading.
      </p>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          className="h-8 w-24 font-mono text-xs"
          value={amount}
          min={0.1}
          max={waxBalance}
          step={1}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !(Number(amount) > 0) || Number(amount) > waxBalance || !canSign}
          onClick={stake}
        >
          {busy ? "Staking…" : "Stake for CPU"}
        </Button>
      </div>
    </div>
  );
}
