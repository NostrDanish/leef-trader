import { ArrowDownUp, ArrowRight, CheckCircle2, Pin, Search, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { pairTokens, MIN_LEEF_BACKING } from "@/lib/leef/amm";
import { rankExecutionRoutes, routeSignature } from "@/lib/leef/route-optimizer";
import { fmtNum, fmtPct } from "@/lib/leef/format";
import { executeSwap, type SwapOutcome } from "@/lib/wallet/trade";
import { hasWalletSession } from "@/lib/wallet/session";
import { hasSecret } from "@/lib/wallet/secret";
import { useWallet } from "@/store/wallet";
import { headline } from "@/lib/leef/rank";
import { leefLegPoolId } from "@/lib/leef/route-loss";
import type { LeefSnapshot, RankedPool, SwapRoute } from "@/lib/leef/types";
import { cn } from "@/lib/utils";
import { useTerminal } from "@/store/terminal";
import { PairMarks, TokenMark } from "./token-mark";

const PRESETS = [1, 10, 50, 100];

export function Quotes({
  snap,
  ranked,
}: {
  snap: LeefSnapshot;
  ranked: RankedPool[];
}) {
  const tokenIn = useTerminal((s) => s.tokenIn);
  const tokenOut = useTerminal((s) => s.tokenOut);
  const amountIn = useTerminal((s) => s.amountIn);
  const slippage = useTerminal((s) => s.slippage);
  const setSwap = useTerminal((s) => s.setSwap);
  const flipSwap = useTerminal((s) => s.flipSwap);
  const selectPool = useTerminal((s) => s.selectPool);
  const swapMaxHops = useTerminal((s) => s.swapMaxHops);
  const setSwapMaxHops = useTerminal((s) => s.setSwapMaxHops);
  const selectedRouteSig = useTerminal((s) => s.selectedRouteSig);
  const selectRoute = useTerminal((s) => s.selectRoute);
  const head = headline(ranked);

  const tokens = useMemo(
    () => pairTokens(snap.pools, [tokenIn, tokenOut]),
    [snap.pools, tokenIn, tokenOut],
  );
  const amount = Number(amountIn) || 0;

  const routes = useMemo(
    () => rankExecutionRoutes(snap.pools, snap.aux, amount, tokenIn, tokenOut, swapMaxHops),
    [snap.pools, snap.aux, amount, tokenIn, tokenOut, swapMaxHops],
  );

  const best = routes[0];
  const runner = routes[1];
  // A pinned route drives the quote card + the trade button; Auto = best.
  const pinned = selectedRouteSig
    ? (routes.find((r) => routeSignature(r) === selectedRouteSig) ?? null)
    : null;
  const active = pinned ?? best;
  const edge =
    best && runner && runner.amountOut > 0
      ? best.amountOut / runner.amountOut - 1
      : 0;

  return (
    <div className="flex flex-col gap-6">
      {head.arb && (
        <Card className="border-warn/30 bg-warn/5 p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-warn">
                Cross-pool mispricing
              </div>
              <p className="mt-1 max-w-2xl text-sm text-fg">
                LEEF is {fmtPct(head.arb.spreadPct, 1, false)} cheaper on pool #
                {head.arb.cheap.id} ({head.arb.cheap.pair.symbol}) than on pool #
                {head.arb.rich.id}.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSwap({ tokenIn: "WAX", tokenOut: "LEEF", amountIn: "10" });
                selectPool(head.arb!.cheap.id);
              }}
            >
              Inspect cheap book
            </Button>
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="min-w-0 p-4 sm:p-5 lg:col-span-2">
          <div className="mb-4">
            <h2 className="text-base font-medium tracking-tight">Size quote</h2>
            <p className="text-xs text-muted-foreground">
              Same notional against every ≥1M LEEF book, including non-WAX. Hops
              via WAX or the pair token. Read-only.
            </p>
          </div>

          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-bg p-3">
              <div className="mb-1 text-xs text-muted-foreground">Input size</div>
              <div className="flex items-center gap-2">
                <Input
                  inputMode="decimal"
                  value={amountIn}
                  onChange={(e) => setSwap({ amountIn: e.target.value })}
                  className="border-0 bg-transparent px-0 text-2xl font-medium h-12"
                />
                <TokenSelect
                  value={tokenIn}
                  tokens={tokens}
                  onChange={(v) => setSwap({ tokenIn: v })}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {PRESETS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() =>
                      setSwap({
                        amountIn: tokenIn === "LEEF" ? String(n * 100_000) : String(n),
                      })
                    }
                    className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-fg"
                  >
                    {tokenIn === "LEEF" ? `${n * 100}k` : n}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex justify-center -my-1 relative z-10">
              <Button
                variant="secondary"
                size="icon"
                className="size-9 rounded-full"
                onClick={flipSwap}
                aria-label="Flip direction"
              >
                <ArrowDownUp className="size-4" />
              </Button>
            </div>

            <div className="rounded-lg border border-border bg-bg p-3">
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>{pinned ? "Pinned route fill" : "Best fill"}</span>
                {pinned && (
                  <Badge variant="accent" className="gap-1">
                    <Pin className="size-3" /> Pinned
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                <div className="h-12 min-w-0 flex-1 overflow-x-auto font-mono text-xl font-medium tabular-nums text-leef sm:text-2xl">
                  {active ? fmtNum(active.amountOut, { compact: true }) : "0.00"}
                </div>
                <TokenSelect
                  value={tokenOut}
                  tokens={tokens}
                  onChange={(v) => setSwap({ tokenOut: v })}
                />
              </div>
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Slippage {slippage}%</span>
              <div className="flex gap-1">
                {[0.1, 0.5, 1, 2.5].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSwap({ slippage: s })}
                    className={cn(
                      "rounded-md px-2 py-1 border",
                      slippage === s
                        ? "border-accent/40 bg-accent/10 text-accent"
                        : "border-border text-muted-foreground hover:text-fg",
                    )}
                  >
                    {s}%
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Max hops</span>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 6, 10].map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => setSwapMaxHops(h)}
                    className={cn(
                      "rounded-md px-2 py-1 border tabular-nums",
                      swapMaxHops === h
                        ? "border-accent/40 bg-accent/10 text-accent"
                        : "border-border text-muted-foreground hover:text-fg",
                    )}
                  >
                    {h}
                  </button>
                ))}
              </div>
            </div>

            {active && (
              <dl className="space-y-1.5 rounded-lg border border-border bg-surface-2 p-3 text-xs">
                <Row label={pinned ? "Pinned path" : "Winning book"} value={active.label} />
                <Row
                  label="Execution"
                  value={`1 ${tokenIn} = ${fmtNum(active.executionPrice)} ${tokenOut}`}
                />
                <Row
                  label="Price impact"
                  value={fmtPct(active.priceImpact, 2, false)}
                  tone={
                    active.priceImpact > 0.05
                      ? "sell"
                      : active.priceImpact > 0.02
                        ? "warn"
                        : "buy"
                  }
                />
                <Row label="Fees on path" value={`${active.feePct.toFixed(2)}%`} />
                <Row
                  label="Min received"
                  value={`${fmtNum(active.amountOut * (1 - slippage / 100))} ${tokenOut}`}
                />
                {!pinned && edge > 0.001 && runner && (
                  <Row
                    label="Vs next book"
                    value={`${fmtPct(edge, 1)} more than #${runner.poolIds[0]}`}
                    tone="leef"
                  />
                )}
                {pinned && best && pinned.id !== best.id && (
                  <Row
                    label="Vs best route"
                    value={fmtPct(pinned.amountOut / best.amountOut - 1, 2)}
                    tone={pinned.amountOut >= best.amountOut ? "leef" : "warn"}
                  />
                )}
              </dl>
            )}

            {active && <TradeButton snap={snap} />}
            <p className="text-center text-xs text-subtle">
              {pinned
                ? "Pinned route — exactly this path is executed, or the trade errors. Never a silent fallback."
                : "Auto — best executable route for this exact size; hops and splits only when they pay. Click a route on the right to pin it."}
            </p>
          </div>
        </Card>

        <div className="flex min-w-0 flex-col gap-3 lg:col-span-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">Ranked fills</h3>
              <p className="text-xs text-muted-foreground">
                {routes.length} route{routes.length === 1 ? "" : "s"} on books with ≥{" "}
                {(MIN_LEEF_BACKING / 1_000_000).toFixed(0)}M LEEF
                {best?.kind === "hop"
                  ? " · multi-hop"
                  : best?.kind === "split"
                    ? " · split across books"
                    : ""}
              </p>
            </div>
            {best && (
              <Badge variant="leef">
                Best · {fmtNum(best.amountOut, { compact: true })} {tokenOut}
              </Badge>
            )}
          </div>

          {routes.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              No backed LEEF pool (≥ 1M LEEF) can fill {tokenIn} → {tokenOut}. Try
              WAX or LEEF as one side.
            </Card>
          ) : (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => selectRoute(null)}
                className={cn(
                  "flex items-center justify-between rounded-lg border p-3 text-left text-sm transition-colors duration-[var(--motion-quick)]",
                  selectedRouteSig == null
                    ? "border-accent/40 bg-accent/5"
                    : "border-dashed border-border bg-surface hover:border-accent/25",
                )}
              >
                <span className="flex items-center gap-2">
                  <Zap className="size-3.5 text-accent" />
                  <span>
                    <span className="font-medium">Auto · best route for this size</span>
                    <span className="block text-xs text-muted-foreground">
                      The engine picks — hops and splits only when they pay.
                    </span>
                  </span>
                </span>
                {selectedRouteSig == null && <Badge variant="accent">Selected</Badge>}
              </button>
              {routes.slice(0, 12).map((r, i) => (
                <RouteRow
                  key={r.id}
                  route={r}
                  rank={i + 1}
                  isBest={i === 0}
                  selected={routeSignature(r) === selectedRouteSig}
                  onSelect={() =>
                    selectRoute(
                      routeSignature(r) === selectedRouteSig ? null : routeSignature(r),
                    )
                  }
                  onInspect={() => selectPool(leefLegPoolId(r))}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TradeButton({ snap }: { snap: LeefSnapshot }) {
  const tokenIn = useTerminal((s) => s.tokenIn);
  const tokenOut = useTerminal((s) => s.tokenOut);
  const amountIn = useTerminal((s) => s.amountIn);
  const slippage = useTerminal((s) => s.slippage);
  const swapMaxHops = useTerminal((s) => s.swapMaxHops);
  const selectedRouteSig = useTerminal((s) => s.selectedRouteSig);
  const setImportOpen = useWallet((s) => s.setImportOpen);
  const authType = useWallet((s) => s.authType);
  const mode = useWallet((s) => s.mode);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SwapOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const live = mode === "live" && (hasSecret() || hasWalletSession());
  const liveBook = snap.source === "live";

  function onTrade() {
    setBusy(true);
    setError(null);
    setDone(null);
    void executeSwap({
      snap,
      tokenIn,
      tokenOut,
      amountIn: Number(amountIn) || 0,
      slippage,
      maxHops: swapMaxHops,
      routeSig: selectedRouteSig ?? undefined,
    })
      .then((outcome) => setDone(outcome))
      .catch((err) => setError(err instanceof Error ? err.message : "Swap failed"))
      .finally(() => setBusy(false));
  }

  return (
    <div className="space-y-2">
      {live ? (
        <Button variant="leef" className="w-full" disabled={busy || !liveBook} onClick={onTrade}>
          <Zap className="size-3.5" />
          {busy ? "Signing…" : `Swap ${amountIn || "0"} ${tokenIn} → ${tokenOut}`}
        </Button>
      ) : (
        <Button variant="leef" className="w-full" disabled={busy || !liveBook} onClick={onTrade}>
          <Zap className="size-3.5" />
          {busy ? "Filling…" : `Paper swap ${amountIn || "0"} ${tokenIn} → ${tokenOut}`}
        </Button>
      )}
      {!live && (
        <Button variant="outline" className="w-full" size="sm" onClick={() => setImportOpen(true)}>
          Connect wallet for live swaps
        </Button>
      )}
      {done && (
        <div className="flex items-start gap-2 rounded-lg border border-leef/30 bg-leef/10 px-3 py-2 text-xs">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-leef" />
          <span>
            {done.mode === "live"
              ? done.confirmed
                ? "Live fill · confirmed on-chain"
                : "Live fill · confirmation pending — amount is the router quote"
              : "Paper fill"}{" "}
            · {fmtNum(done.amountOut, { compact: true })} {tokenOut} on {done.routeLabel}
            {done.txid && (
              <>
                {" · "}
                <a
                  className="font-mono text-accent hover:underline"
                  href={`https://waxblock.io/transaction/${done.txid}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  tx {done.txid.slice(0, 10)}…
                </a>
              </>
            )}
          </span>
        </div>
      )}
      {error && (
        <p className="rounded-lg border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
          {error}
        </p>
      )}
    </div>
  );
}

function RouteRow({
  route,
  rank,
  isBest,
  selected,
  onSelect,
  onInspect,
}: {
  route: SwapRoute;
  rank: number;
  isBest: boolean;
  selected: boolean;
  onSelect: () => void;
  onInspect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "cursor-pointer rounded-lg border p-3 text-left transition-colors duration-[var(--motion-quick)]",
        selected
          ? "border-leef/50 bg-leef/5 ring-1 ring-leef/30"
          : isBest
            ? "border-accent/40 bg-accent/5 hover:border-accent/60"
            : "border-border bg-surface hover:border-accent/25",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              "font-mono text-xs tabular-nums pt-0.5",
              selected ? "text-leef" : isBest ? "text-accent" : "text-subtle",
            )}
          >
            {String(rank).padStart(2, "0")}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <PairMarks
                pair={
                  route.legs[0]?.tokenOut === "LEEF"
                    ? route.legs[0].tokenIn
                    : (route.legs[route.legs.length - 1]?.tokenOut ?? "WAX")
                }
              />
              <span className="text-sm font-medium truncate">{route.label}</span>
              {isBest && <Badge variant="accent">Best executable</Badge>}
              {selected && (
                <Badge variant="leef" className="gap-1">
                  <Pin className="size-3" /> Pinned
                </Badge>
              )}
              {route.kind === "hop" && <Badge>{route.legs.length}-hop</Badge>}
              {route.kind === "split" && <Badge>split</Badge>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-mono">
                {route.tokenIn}
                <ArrowRight className="size-3" />
                {route.tokenOut}
              </span>
              <span>impact {fmtPct(route.priceImpact, 2, false)}</span>
              <span>fee {route.feePct.toFixed(2)}%</span>
              {route.notes.map((n) => (
                <span key={n} className="text-subtle">
                  {n}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="text-right">
            <div className="font-mono text-sm tabular-nums text-fg">
              {fmtNum(route.amountOut, { compact: true })} {route.tokenOut}
            </div>
            <div
              className={cn(
                "text-xs font-mono tabular-nums",
                isBest ? "text-leef" : "text-sell",
              )}
            >
              {isBest ? "leading" : fmtPct(route.vsBestPct, 1)}
            </div>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onInspect();
            }}
            aria-label="Inspect pool"
            className="rounded-md p-1 text-subtle hover:text-accent hover:bg-accent/10"
          >
            <Search className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function TokenSelect({
  value,
  tokens,
  onChange,
}: {
  value: string;
  tokens: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2 py-1.5">
      <TokenMark symbol={value} size="sm" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 bg-transparent text-sm font-medium text-fg focus:outline-none"
      >
        {tokens.map((t) => (
          <option key={t} value={t} className="bg-surface text-fg">
            {t}
          </option>
        ))}
      </select>
    </label>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "buy" | "sell" | "warn" | "leef";
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "font-mono tabular-nums text-fg",
          tone === "buy" && "text-buy",
          tone === "sell" && "text-sell",
          tone === "warn" && "text-warn",
          tone === "leef" && "text-leef",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
