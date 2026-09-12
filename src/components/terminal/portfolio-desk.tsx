import {
  ArrowDown,
  ArrowUp,
  ArrowRight,
  CirclePlay,
  CircleStop,
  PieChart,
  ShieldAlert,
  Trash2,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  holdingsFromBalances,
  planRebalance,
  targetShares,
} from "@/lib/leef/rebalance";
import { fmtNum, fmtUsd } from "@/lib/leef/format";
import type { LeefSnapshot } from "@/lib/leef/types";
import { findToken } from "@/lib/leef/universe";
import { portfolioState } from "@/lib/market/portfolio-governor";
import { hasSecret } from "@/lib/wallet/secret";
import { hasWalletSession } from "@/lib/wallet/session";
import { cn } from "@/lib/utils";
import { usePortfolio } from "@/store/portfolio";
import { useWallet } from "@/store/wallet";
import { TokenMark } from "./token-mark";
import { runRebalancer } from "./use-portfolio-loop";

export function PortfolioDesk({ snap }: { snap: LeefSnapshot }) {
  const p = usePortfolio();
  const mode = useWallet((s) => s.mode);
  const account = useWallet((s) => s.account);
  const paperBalances = useWallet((s) => s.paperBalances);
  const liveBalances = useWallet((s) => s.liveBalances);
  const balances = mode === "live" ? liveBalances : paperBalances;
  const [confirmLive, setConfirmLive] = useState(false);
  const [sweeping, setSweeping] = useState(false);

  const liveReady = mode === "live" && (hasSecret() || hasWalletSession());
  const liveBook = snap.source === "live";

  const { holdings, unknown } = holdingsFromBalances(
    balances,
    snap.universe,
    snap.spotAt ?? snap.fetchedAt,
  );
  const totalUsd = holdings.reduce((s, h) => s + h.usd, 0);
  const governor = portfolioState(snap, balances);
  const shares = targetShares(p.ladder);
  const ladderSet = new Set(p.ladder);

  const preview = planRebalance({
    holdings,
    ladder: p.ladder,
    universe: snap.universe,
    settings: p.settings,
    balances,
  });

  const nextIn = p.running
    ? Math.max(0, Math.ceil((p.lastRunAt + p.settings.intervalSec * 1000 - Date.now()) / 1000))
    : null;

  function onStart() {
    if (liveReady && !confirmLive) {
      setConfirmLive(true);
      return;
    }
    setConfirmLive(false);
    p.start();
    void runRebalancer(snap, { force: true });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-base font-medium tracking-tight">Portfolio rebalancer</h2>
          <p className="text-xs text-muted-foreground">
            Set a priority ladder. The engine values every token you hold, sweeps
            dust upward, repairs drift between priorities, and routes each leg
            through Alcor — live mode batches the whole sweep into one atomic
            WAX transaction.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={p.running ? (liveReady ? "leef" : "accent") : "plain"}>
            {p.running ? (liveReady ? "Live · running" : "Paper · running") : "Stopped"}
          </Badge>
          <Badge
            variant={
              governor.state === "RUNNING"
                ? "leef"
                : governor.state === "ASSET_CONCENTRATION"
                  ? "warn"
                  : "plain"
            }
          >
            Governor · {governor.state.toLowerCase().replaceAll("_", " ")}
          </Badge>
          <Badge variant="plain">{p.cycles} cycles</Badge>
          <Badge variant="wax">{fmtUsd(p.movedUsd, 2)} moved</Badge>
        </div>
      </div>

      {p.running && liveReady && (
        <div className="flex items-start gap-2 rounded-lg border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          Live rebalancer is spending real tokens from {account} via swap.alcor
          every {p.settings.intervalSec}s when the book drifts.
        </div>
      )}
      {!liveBook && (
        <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          The Alcor book is stale — sweeps pause until live data returns.
        </div>
      )}
      <div
        className={cn(
          "rounded-lg border px-3 py-2 text-xs",
          governor.state === "RUNNING"
            ? "border-leef/30 bg-leef/5 text-muted-foreground"
            : "border-warn/30 bg-warn/10 text-warn",
        )}
      >
        Portfolio governor: {governor.reason}. Profit strategies can deploy only
        inventory above operational reserves; post-trade concentration is simulated
        before execution.
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        {/* ------------------------------ left rail ------------------------------ */}
        <div className="flex min-w-0 flex-col gap-5 lg:col-span-2">
          <Card className="p-4 sm:p-5">
            <h3 className="mb-1 flex items-center gap-2 text-sm font-medium">
              <PieChart className="size-4 text-accent" />
              Priority ladder
            </h3>
            <p className="mb-4 text-xs text-muted-foreground">
              Rank 1 gets the heaviest target weight; dust and profits always
              consolidate into the highest available priority.
            </p>
            <div className="flex flex-col gap-2">
              {p.ladder.map((id, i) => {
                const t = findToken(snap.universe, id);
                const share = shares.get(id) ?? 0;
                return (
                  <div
                    key={id}
                    className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2"
                  >
                    <span className="w-5 text-center font-mono text-xs text-accent">{i + 1}</span>
                    <TokenMark symbol={t?.symbol ?? "?"} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">{t?.symbol ?? id}</span>
                      <span className="block truncate font-mono text-xs text-subtle">
                        {t?.contract ?? "not in universe"}
                      </span>
                    </span>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {(share * 100).toFixed(1)}%
                    </span>
                    <span className="flex items-center">
                      <button
                        type="button"
                        aria-label="Move up"
                        disabled={i === 0 || p.running}
                        onClick={() => p.moveLadder(i, -1)}
                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground disabled:opacity-30"
                      >
                        <ArrowUp className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label="Move down"
                        disabled={i === p.ladder.length - 1 || p.running}
                        onClick={() => p.moveLadder(i, 1)}
                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground disabled:opacity-30"
                      >
                        <ArrowDown className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label="Remove"
                        disabled={p.ladder.length <= 1 || p.running}
                        onClick={() => p.removeFromLadder(id)}
                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sell/10 hover:text-sell disabled:opacity-30"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
            <AddToken p={p} snap={snap} />
          </Card>

          <Card className="p-4 sm:p-5">
            <h3 className="mb-1 text-sm font-medium">Engine</h3>
            <p className="mb-4 text-xs text-muted-foreground">{p.lastPlanNote}</p>
            {p.running ? (
              <Button variant="danger" className="h-12 w-full text-base" onClick={() => p.stop()}>
                <CircleStop className="size-4" />
                Stop rebalancer
              </Button>
            ) : (
              <Button
                variant="leef"
                className="h-12 w-full text-base"
                onClick={onStart}
                disabled={!liveBook}
              >
                <CirclePlay className="size-4" />
                {confirmLive
                  ? "Real funds will be swept — click again to start LIVE"
                  : `Start ${liveReady ? "live" : "paper"} rebalancer`}
              </Button>
            )}
            {confirmLive && !p.running && (
              <p className="mt-2 text-xs text-sell">
                Live sweeps move real tokens from {account} into the ladder.
                Every leg carries a min-out guard and the batch is atomic.
              </p>
            )}
            {nextIn != null && (
              <p className="mt-2 text-center text-xs text-subtle">
                Next check in {Math.floor(nextIn / 60)}:{String(nextIn % 60).padStart(2, "0")}
              </p>
            )}

            <div className="mt-4 space-y-3 border-t border-border pt-4">
              <SliderRow
                label="Check every"
                value={p.settings.intervalSec}
                min={10}
                max={1800}
                step={5}
                format={(v) =>
                  v < 60 ? `${v}s` : `${Math.round(v / 60)}m`
                }
                onChange={(intervalSec) => p.setSettings({ intervalSec })}
              />
              <SliderRow
                label="Min dust to sweep"
                value={p.settings.minDustUsd}
                min={0.25}
                max={20}
                step={0.25}
                format={(v) => `$${v.toFixed(2)}`}
                onChange={(minDustUsd) => p.setSettings({ minDustUsd })}
              />
              <SliderRow
                label="Drift trigger"
                value={p.settings.driftPct}
                min={5}
                max={40}
                step={1}
                format={(v) => `${v}%`}
                onChange={(driftPct) => p.setSettings({ driftPct })}
              />
              <SliderRow
                label="Max legs per sweep"
                value={p.settings.maxLegs}
                min={1}
                max={6}
                step={1}
                format={(v) => String(v)}
                onChange={(maxLegs) => p.setSettings({ maxLegs })}
              />
              <SliderRow
                label="WAX reserve (CPU)"
                value={p.settings.reserveWax}
                min={0}
                max={50}
                step={1}
                format={(v) => `${v} WAX`}
                onChange={(reserveWax) => p.setSettings({ reserveWax })}
              />
            </div>
          </Card>
        </div>

        {/* ------------------------------ right rail ------------------------------ */}
        <div className="flex min-w-0 flex-col gap-5 lg:col-span-3">
          <Card className="border-accent/30 bg-accent/5 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-medium uppercase tracking-wider text-accent">
                Next sweep plan
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={sweeping || !liveBook}
                onClick={() => {
                  setSweeping(true);
                  void runRebalancer(snap, { force: true }).finally(() => setSweeping(false));
                }}
              >
                <Zap className="size-3.5" />
                {sweeping ? "Sweeping…" : "Run sweep now"}
              </Button>
            </div>
            {preview.legs.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {preview.notes[0] ?? "Portfolio is balanced"}
              </p>
            ) : (
              <div className="mt-2 flex flex-col gap-1.5">
                {preview.legs.map((l, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant={l.kind === "dust" ? "wax" : "accent"}>{l.kind}</Badge>
                    <span className="font-mono tabular-nums">
                      {fmtNum(l.amountIn, { compact: true })} {l.from.symbol}
                    </span>
                    <ArrowRight className="size-3 text-subtle" />
                    <span className="font-mono text-foreground">{l.to.symbol}</span>
                    <span className="text-subtle">· {l.reason}</span>
                  </div>
                ))}
                <p className="mt-1 text-xs text-subtle">
                  Quotes from Alcor's router at execution — split routes used when they pay more.
                </p>
              </div>
            )}
          </Card>

          <Card className="p-4 sm:p-5">
            <h3 className="mb-3 text-sm font-medium">
              Holdings <span className="text-muted-foreground">· {fmtUsd(totalUsd, 2)}</span>
            </h3>
            {holdings.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No priced holdings found. Connect a wallet for live balances.
              </p>
            ) : (
              <div className="-mx-4 min-w-0 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                <table className="w-full min-w-[820px] text-left text-xs">
                  <thead className="text-subtle">
                    <tr className="border-b border-border">
                      <th className="py-2 pr-3 font-medium">Token</th>
                      <th className="py-2 pr-3 font-medium">Amount</th>
                      <th className="py-2 pr-3 font-medium">Price</th>
                      <th className="py-2 pr-3 font-medium">USD value</th>
                      <th className="py-2 pr-3 font-medium">Source / confidence</th>
                      <th className="py-2 pr-3 font-medium">Share</th>
                      <th className="py-2 font-medium">Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.map((h) => {
                      const share = totalUsd > 0 ? h.usd / totalUsd : 0;
                      const target = shares.get(h.token.alcorId) ?? 0;
                      const onLadder = ladderSet.has(h.token.alcorId);
                      const drift = target > 0 ? share / target - 1 : 0;
                      return (
                        <tr key={h.token.alcorId} className="border-b border-border/70">
                          <td className="py-2.5 pr-3">
                            <span className="flex items-center gap-2">
                              <TokenMark symbol={h.token.symbol} size="sm" />
                              <span>
                                <span className="block font-mono">{h.token.symbol}</span>
                                <span className="block font-mono text-subtle">
                                  {h.token.contract}
                                </span>
                              </span>
                            </span>
                          </td>
                          <td className="py-2.5 pr-3 font-mono tabular-nums">
                            {fmtNum(h.amount, { compact: true, digits: 4 })}
                          </td>
                          <td className="py-2.5 pr-3 font-mono tabular-nums">
                            {fmtUsd(h.price.priceUsd)}
                            {h.price.stableState && (
                              <span
                                className={cn(
                                  "ml-1 text-[10px]",
                                  h.price.stableState === "PEGGED" ? "text-leef" : "text-warn",
                                )}
                              >
                                {h.price.stableState}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 pr-3 font-mono tabular-nums">
                            {fmtUsd(h.usd, 2)}
                          </td>
                          <td className="py-2.5 pr-3">
                            <span className="block text-foreground">
                              {h.price.source.replaceAll("-", " ")}
                            </span>
                            <span
                              className={cn(
                                "font-mono tabular-nums",
                                h.price.confidence >= 0.8 ? "text-leef" : "text-warn",
                              )}
                            >
                              {(h.price.confidence * 100).toFixed(0)}% · {fmtUsd(h.price.liquidityUsd, 0)} liq
                            </span>
                          </td>
                          <td className="py-2.5 pr-3">
                            <span className="flex items-center gap-2">
                              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2">
                                <span
                                  className={cn(
                                    "block h-full",
                                    onLadder ? "bg-accent" : "bg-wax",
                                  )}
                                  style={{ width: `${Math.min(100, share * 100)}%` }}
                                />
                              </span>
                              <span className="font-mono tabular-nums text-muted-foreground">
                                {(share * 100).toFixed(1)}%
                              </span>
                            </span>
                          </td>
                          <td className="py-2.5">
                            {onLadder ? (
                              <span
                                className={cn(
                                  "font-mono tabular-nums",
                                  Math.abs(drift) * 100 > p.settings.driftPct
                                    ? "text-warn"
                                    : "text-muted-foreground",
                                )}
                              >
                                {(target * 100).toFixed(1)}%
                                <span className="ml-1 text-subtle">
                                  ({drift >= 0 ? "+" : ""}
                                  {(drift * 100).toFixed(0)}%)
                                </span>
                              </span>
                            ) : (
                              <Badge variant="wax">dust</Badge>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {unknown.length > 0 && (
              <p className="mt-3 text-xs text-subtle">
                No liquid pool to price: {unknown.slice(0, 8).join(", ")}
                {unknown.length > 8 ? "…" : ""}
              </p>
            )}
          </Card>

          <Card className="p-4 sm:p-5">
            <h3 className="mb-1 text-sm font-medium">Sweep log</h3>
            <p className="mb-3 text-xs text-muted-foreground">
              Swept {fmtUsd(p.sweptUsd, 2)} of dust lifetime · moved {fmtUsd(p.movedUsd, 2)} total.
            </p>
            {p.log.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No sweeps yet — start the engine or run one manually.
              </p>
            ) : (
              <div className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
                {p.log.map((e) => (
                  <div
                    key={e.id}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-muted-foreground">
                        {new Date(e.t).toISOString().slice(11, 19)} UTC
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="font-mono tabular-nums text-muted-foreground">
                          {fmtUsd(e.totalUsd, 2)}
                        </span>
                        <Badge
                          variant={
                            e.status === "filled"
                              ? e.mode === "live"
                                ? "leef"
                                : "accent"
                              : e.status === "failed"
                                ? "sell"
                                : "plain"
                          }
                        >
                          {e.mode} · {e.status}
                        </Badge>
                      </span>
                    </div>
                    <div className="mt-1 text-foreground">{e.summary}</div>
                    {e.legs.map((l, i) => (
                      <div key={i} className="mt-0.5 font-mono text-subtle">
                        {l}
                      </div>
                    ))}
                    {e.txid && (
                      <a
                        className="mt-0.5 block font-mono text-accent hover:underline"
                        href={`https://waxblock.io/transaction/${e.txid}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        tx {e.txid.slice(0, 14)}…
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function AddToken({
  p,
  snap,
}: {
  p: ReturnType<typeof usePortfolio.getState>;
  snap: LeefSnapshot;
}) {
  const [pick, setPick] = useState("");
  const available = snap.universe.filter((t) => !p.ladder.includes(t.alcorId)).slice(0, 60);
  if (p.ladder.length >= 5) {
    return (
      <p className="mt-2 text-xs text-subtle">Ladder is full (5 priorities max).</p>
    );
  }
  return (
    <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
      <select
        className="h-11 flex-1 rounded-md border border-border bg-surface-2 px-2 text-xs"
        value={pick}
        onChange={(e) => setPick(e.target.value)}
        aria-label="Token to add"
        disabled={p.running}
      >
        <option value="">Add priority token…</option>
        {available.map((t) => (
          <option key={t.alcorId} value={t.alcorId}>
            {t.symbol} · {t.contract} · {fmtUsd(t.tvlUsd, 0)} TVL
          </option>
        ))}
      </select>
      <Button
        variant="secondary"
        size="sm"
        disabled={!pick || p.running}
        onClick={() => {
          if (pick) p.addToLadder(pick);
          setPick("");
        }}
      >
        Add
      </Button>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const safe = Number.isFinite(value) ? value : min;
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums text-foreground">{format(safe)}</span>
      </span>
      <input
        type="range"
        className="w-full accent-teal-300"
        min={min}
        max={max}
        step={step}
        value={safe}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Number(n.toFixed(4)));
        }}
        aria-label={label}
      />
    </label>
  );
}
