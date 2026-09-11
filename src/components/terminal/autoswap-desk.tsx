import { ShieldAlert, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { compareAllRoutes, pairTokens } from "@/lib/leef/amm";
import { fmtNum, fmtPct } from "@/lib/leef/format";
import { leefLegPoolId } from "@/lib/leef/route-loss";
import type { LeefSnapshot } from "@/lib/leef/types";
import { hasSecret } from "@/lib/wallet/secret";
import { useTerminal } from "@/store/terminal";
import { useWallet } from "@/store/wallet";
import { runClip } from "./use-wallet-sync";

export function AutoswapDesk({ snap }: { snap: LeefSnapshot }) {
  const auto = useWallet((s) => s.auto);
  const setAuto = useWallet((s) => s.setAuto);
  const mode = useWallet((s) => s.mode);
  const account = useWallet((s) => s.account);
  const log = useWallet((s) => s.log);
  const lastVerdict = useWallet((s) => s.lastVerdict);
  const cooldownUntil = useWallet((s) => s.cooldownUntil);
  const clipsThisHour = useWallet((s) => s.clipsThisHour);
  const setImportOpen = useWallet((s) => s.setImportOpen);
  const setSwap = useTerminal((s) => s.setSwap);
  const tokens = pairTokens(snap.pools, [auto.tokenIn, auto.tokenOut]);
  const amount = Number(auto.amountIn) || 0;
  const routes = compareAllRoutes(snap.pools, snap.aux, amount, auto.tokenIn, auto.tokenOut);
  const best = routes[0];
  const runner = routes[1];
  const edge =
    best && runner && runner.amountOut > 0 ? best.amountOut / runner.amountOut - 1 : 0;
  const liveReady = mode === "live" && hasSecret();
  const coolLeft = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  const [slidersOn, setSlidersOn] = useState(false);
  const [clipping, setClipping] = useState(false);
  useEffect(() => setSlidersOn(true), []);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-base font-medium tracking-tight">Autoswap</h2>
          <p className="text-xs text-muted-foreground">
            Each 30s book pull, clip the least-loss route if it beats the next book. Paper
            by default. Live broadcast needs a key in this tab.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={auto.enabled ? "accent" : "plain"}>
            {auto.enabled ? (auto.armed && liveReady ? "Live armed" : "Paper on") : "Off"}
          </Badge>
          <Badge variant="plain">
            {clipsThisHour}/{auto.maxClipsHour} clips this hour
          </Badge>
        </div>
      </div>

      {auto.armed && liveReady && (
        <div className="flex items-start gap-2 rounded-lg border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          Live arm spends real tokens from {account} via swap.alcor on the routed pool.
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="p-5 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">Engine</h3>
              <p className="text-xs text-muted-foreground">{lastVerdict}</p>
            </div>
            <label className="flex h-11 items-center gap-2 text-xs">
              <span className="text-muted-foreground">Run</span>
              <Switch
                checked={auto.enabled}
                onCheckedChange={(enabled) => setAuto({ enabled })}
                aria-label="Enable autoswap"
              />
            </label>
          </div>

          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-bg p-3">
              <div className="mb-1 text-xs text-muted-foreground">Clip size</div>
              <div className="flex items-center gap-2">
                <Input
                  inputMode="decimal"
                  value={auto.amountIn}
                  onChange={(e) => setAuto({ amountIn: e.target.value })}
                  className="h-12 border-0 bg-transparent px-0 text-2xl font-medium"
                />
                <select
                  className="h-11 rounded-md border border-border bg-surface-2 px-2 text-xs"
                  value={auto.tokenIn}
                  onChange={(e) => setAuto({ tokenIn: e.target.value })}
                  aria-label="Token in"
                >
                  {tokens.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="rounded-lg border border-border bg-bg p-3">
              <div className="mb-1 text-xs text-muted-foreground">Receive</div>
              <div className="flex items-center gap-2">
                <div className="h-12 flex-1 font-mono text-2xl font-medium tabular-nums text-leef">
                  {best ? fmtNum(best.amountOut, { compact: true }) : "—"}
                </div>
                <select
                  className="h-11 rounded-md border border-border bg-surface-2 px-2 text-xs"
                  value={auto.tokenOut}
                  onChange={(e) => setAuto({ tokenOut: e.target.value })}
                  aria-label="Token out"
                >
                  {tokens.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <Knob
              ready={slidersOn}
              label="Min edge vs next book"
              value={auto.minEdgePct}
              min={0}
              max={5}
              step={0.05}
              format={(v) => `${v.toFixed(2)}%`}
              onChange={(minEdgePct) => setAuto({ minEdgePct })}
            />
            <Knob
              ready={slidersOn}
              label="Max impact"
              value={auto.maxImpactPct}
              min={0.2}
              max={8}
              step={0.1}
              format={(v) => `${v.toFixed(1)}%`}
              onChange={(maxImpactPct) => setAuto({ maxImpactPct })}
            />
            <Knob
              ready={slidersOn}
              label="Cooldown"
              value={auto.cooldownSec}
              min={30}
              max={300}
              step={15}
              format={(v) => `${v}s`}
              onChange={(cooldownSec) => setAuto({ cooldownSec })}
            />
            <Knob
              ready={slidersOn}
              label="Slippage"
              value={auto.slippage}
              min={0.1}
              max={3}
              step={0.1}
              format={(v) => `${v.toFixed(1)}%`}
              onChange={(slippage) => setAuto({ slippage })}
            />
            <Knob
              ready={slidersOn}
              label="Clips / hour"
              value={auto.maxClipsHour}
              min={1}
              max={20}
              step={1}
              format={(v) => String(v)}
              onChange={(maxClipsHour) => setAuto({ maxClipsHour })}
            />
          </div>

          <div className="mt-4 flex flex-col gap-2">
            <Button
              variant="leef"
              disabled={clipping}
              onClick={() => {
                setClipping(true);
                void runClip(snap, { force: true }).finally(() => setClipping(false));
              }}
            >
              <Zap className="size-3.5" />
              {clipping ? "Clipping…" : "Clip this book"}
            </Button>
            {!liveReady ? (
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                Import key to arm live
              </Button>
            ) : (
              <Button
                variant={auto.armed ? "danger" : "outline"}
                onClick={() => setAuto({ armed: !auto.armed })}
              >
                {auto.armed ? "Disarm live" : "Arm live broadcasts"}
              </Button>
            )}
            {coolLeft > 0 && (
              <p className="text-center text-xs text-subtle">Next auto clip in {coolLeft}s</p>
            )}
          </div>
        </Card>

        <div className="flex flex-col gap-3 lg:col-span-3">
          <Card className="border-accent/30 bg-accent/5 p-4 sm:p-5">
            <div className="text-xs font-medium uppercase tracking-wider text-accent">
              Next clip · {auto.tokenIn} → {auto.tokenOut}
            </div>
            {best ? (
              <p className="mt-1 text-sm">
                Would swap on{" "}
                <span className="font-mono">#{leefLegPoolId(best)}</span> {best.label}. Fill{" "}
                {fmtNum(best.amountOut, { compact: true })} {auto.tokenOut} · impact{" "}
                {fmtPct(best.priceImpact, 2, false)} · edge vs next book{" "}
                {fmtPct(edge, 2, false)}.
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">No backed route for this size.</p>
            )}
            {best && (
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() =>
                  setSwap({
                    tokenIn: auto.tokenIn,
                    tokenOut: auto.tokenOut,
                    amountIn: auto.amountIn,
                  })
                }
              >
                Mirror size in Quotes
              </Button>
            )}
          </Card>

          <Card className="p-4 sm:p-5">
            <h3 className="mb-3 text-sm font-medium">Clip log</h3>
            {log.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No clips yet. Clip this book, or turn Run on for each qualifying 30s pull.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {log.slice(0, 14).map((e) => (
                  <div
                    key={e.id}
                    className="rounded-lg border border-border bg-bg px-3 py-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-muted-foreground">
                        {new Date(e.t).toISOString().slice(11, 19)} UTC
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
                    </div>
                    <div className="mt-1 font-mono tabular-nums">
                      {fmtNum(e.amountIn, { compact: true })} {e.tokenIn} →{" "}
                      {fmtNum(e.amountOut, { compact: true })} {e.tokenOut}
                    </div>
                    <div className="mt-0.5 text-subtle">
                      {e.routeLabel}
                      {e.txid ? ` · ${e.txid.slice(0, 10)}…` : ""} · {e.reason}
                    </div>
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

function Knob({
  ready,
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  ready: boolean;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums text-fg">{format(value)}</span>
      </span>
      {ready ? (
        <Slider
          min={min}
          max={max}
          step={step}
          value={[value]}
          onValueChange={([v]) => {
            if (typeof v !== "number") return;
            const n = Number((Math.round(v / step) * step).toFixed(4));
            onChange(n);
          }}
          aria-label={label}
        />
      ) : (
        <div className="h-11" />
      )}
    </label>
  );
}
