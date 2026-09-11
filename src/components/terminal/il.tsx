import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { forecastIl } from "@/lib/leef/il";
import { fmtNum, fmtUsd } from "@/lib/leef/format";
import type { LeefSnapshot } from "@/lib/leef/types";
import { cn } from "@/lib/utils";
import { useTerminal } from "@/store/terminal";

export function IlCalc({ snap }: { snap: LeefSnapshot }) {
  const selectedId = useTerminal((s) => s.selectedPoolId);
  const pool =
    snap.pools.find((p) => p.id === selectedId) ??
    snap.pools.find((p) => p.pair.symbol === "WAX") ??
    snap.pools[0];
  const tvl = pool?.tvlUsd || snap.pools.reduce((a, p) => a + p.tvlUsd, 0) || 1400;
  const liveVol = Math.max(10, Math.round(pool?.volume24Usd || 50));
  const feePct = pool?.feePct ?? 0.3;
  const [deposit, setDeposit] = useState(1000);
  const [change, setChange] = useState(50);
  const [vol, setVol] = useState(liveVol);
  const [days, setDays] = useState(30);

  const r = useMemo(
    () =>
      forecastIl({
        depositUsd: deposit,
        leefChangePct: change,
        dailyVolumeUsd: vol,
        days,
        poolTvlUsd: tvl,
        feePct,
      }),
    [deposit, change, vol, days, tvl, feePct],
  );

  return (
    <Card className="p-5 sm:p-6">
      <h2 className="text-base font-medium tracking-tight">Impermanent loss</h2>
      <p className="mb-6 text-xs text-muted-foreground">
        50/50 book using {pool ? `pool #${pool.id} LEEF / ${pool.pair.symbol}` : "combined TVL"} (
        {fmtUsd(tvl, 0)}) and a {feePct}% fee. Daily volume seeded from the live 24h print.
      </p>
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="space-y-6">
          <Range
            label="Deposit"
            display={fmtUsd(deposit, 0)}
            value={deposit}
            min={100}
            max={20000}
            step={100}
            onChange={setDeposit}
          />
          <Range
            label="LEEF price change"
            display={`${change >= 0 ? "+" : ""}${change}% (${(1 + change / 100).toFixed(2)}x)`}
            value={change}
            min={-80}
            max={400}
            step={5}
            onChange={setChange}
          />
          <Range
            label="Daily pool volume"
            display={`${fmtUsd(vol, 0)} / day`}
            value={vol}
            min={10}
            max={Math.max(2000, liveVol * 4)}
            step={10}
            onChange={setVol}
          />
          <Range
            label="Time in range"
            display={`${days} days`}
            value={days}
            min={1}
            max={365}
            step={1}
            onChange={setDays}
          />
        </div>
        <div className="rounded-lg border border-border bg-bg p-5">
          <div className="mb-4 text-xs uppercase tracking-wider text-subtle">
            Hold vs LP
          </div>
          <Result k="Value if held" v={fmtUsd(r.hodl)} />
          <Result k="Value in pool (pre-fees)" v={fmtUsd(r.poolNoFees)} tone="wax" />
          <Result
            k="Impermanent loss"
            v={`${r.ilPct.toFixed(2)}%`}
            tone="sell"
          />
          <Result k="Est. trading fees" v={`+${fmtUsd(r.fees)}`} tone="buy" />
          <div className="mt-5 flex items-end justify-between border-t border-border pt-4">
            <div>
              <div className="text-xs text-muted-foreground">Net LP value</div>
              <div className="font-mono text-2xl tabular-nums text-leef">
                {fmtUsd(r.net)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-muted-foreground">Fee APY</div>
              <div className="font-mono text-lg tabular-nums text-accent">
                {fmtNum(r.apy, { digits: 1 })}%
              </div>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function Range({
  label,
  display,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  display: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums text-accent">{display}</span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={(v) => onChange(v[0] ?? value)}
      />
    </div>
  );
}

function Result({
  k,
  v,
  tone,
}: {
  k: string;
  v: string;
  tone?: "buy" | "sell" | "wax";
}) {
  return (
    <div className="mb-2 flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2 text-sm">
      <span className="text-xs text-muted-foreground">{k}</span>
      <span
        className={cn(
          "font-mono tabular-nums",
          tone === "buy" && "text-buy",
          tone === "sell" && "text-sell",
          tone === "wax" && "text-wax",
        )}
      >
        {v}
      </span>
    </div>
  );
}
