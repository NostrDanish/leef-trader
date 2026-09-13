import { useEffect, useState, type ReactNode } from "react";
import { Check, Loader2, RotateCcw, Save, Wifi, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtNum, timeAgo } from "@/lib/leef/format";
import { marketEngine } from "@/lib/market/market-engine";
import { TRADING_MAX_BLOCK_LAG, type EndpointHealth } from "@/lib/wax/provider-pool";
import { lastCycleTimings } from "@/lib/wallet/trade-cycle";
import {
  readEndpointConfig,
  resetEndpointConfig,
  writeEndpointConfig,
} from "@/lib/wax/endpoints";
import { useMarketEngine } from "@/hooks/useMarketEngine";
import { cn } from "@/lib/utils";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function statusColor(s: EndpointHealth["status"]): string {
  if (s === "healthy") return "bg-leef";
  if (s === "degraded") return "bg-warn";
  return "bg-sell";
}

function StatusDot({ ok, warn = false }: { ok: boolean; warn?: boolean }) {
  return (
    <span className="relative flex size-2 shrink-0">
      {ok && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full rounded-full opacity-70",
            warn ? "animate-ping bg-warn" : "animate-ping bg-leef",
          )}
        />
      )}
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full",
          ok ? (warn ? "bg-warn" : "bg-leef") : warn ? "bg-warn" : "bg-sell",
        )}
      />
    </span>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-subtle">
        {title}
      </div>
      <div className="space-y-1.5 text-xs">{children}</div>
    </div>
  );
}

function EndpointRow({ e }: { e: EndpointHealth }) {
  const dead = e.status === "cooldown" || e.status === "disabled";
  return (
    <div className="flex items-center gap-2 font-mono tabular-nums">
      <span className={cn("size-2 shrink-0 rounded-full", statusColor(e.status))} />
      <span className="min-w-0 flex-1 truncate text-fg">{hostOf(e.url)}</span>
      <span className="w-14 text-right text-muted-foreground">
        {e.latencyMs != null ? `${Math.round(e.latencyMs)}ms` : "—"}
      </span>
      <span className="w-16 text-right text-muted-foreground">
        {e.headBlock != null ? `lag ${e.blockLag}` : "no head"}
      </span>
      <span
        className={cn(
          "w-12 text-right",
          e.score >= 60 ? "text-leef" : e.score > 0 ? "text-warn" : "text-sell",
        )}
      >
        {e.score.toFixed(0)}
      </span>
      {e.tradingEligible ? (
        <Badge variant="plain" className="px-1 text-[10px]">
          tx
        </Badge>
      ) : (
        <span className="w-[26px] text-center text-[10px] text-subtle">·</span>
      )}
    </div>
  );
}

function TimingRow({ label, ms }: { label: string; ms: number }) {
  return (
    <div className="flex items-center justify-between font-mono tabular-nums">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn(ms > 4_000 ? "text-warn" : "text-fg")}>
        {ms > 0 ? `${ms.toFixed(0)}ms` : "—"}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function EndpointConfigEditor() {
  const [rpcText, setRpcText] = useState("");
  const [histText, setHistText] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const cfg = readEndpointConfig();
    const eff = marketEngine.getState().endpoints;
    setRpcText((cfg?.rpc ?? eff.rpc).join("\n"));
    setHistText((cfg?.history ?? eff.history).join("\n"));
  }, []);

  const save = () => {
    const clean = (t: string) =>
      t
        .split(/\n+/)
        .map((l) => l.trim().replace(/\/+$/, ""))
        .filter((l) => /^https?:\/\//.test(l) && !/\s/.test(l));
    writeEndpointConfig({ rpc: clean(rpcText), history: clean(histText) });
    marketEngine.reloadEndpoints();
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2_000);
  };

  const reset = () => {
    resetEndpointConfig();
    marketEngine.reloadEndpoints();
    const eff = marketEngine.getState().endpoints;
    setRpcText(eff.rpc.join("\n"));
    setHistText(eff.history.join("\n"));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2_000);
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">
        Endpoints (no rebuild required)
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        One URL per line. Empty = curated defaults. Applies instantly — the provider
        pools hot-reload and re-health-check.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-subtle">Chain RPC pool</span>
          <textarea
            className="h-36 w-full rounded-md border border-border bg-background p-2 font-mono text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            value={rpcText}
            onChange={(e) => setRpcText(e.target.value)}
            spellCheck={false}
            aria-label="Chain RPC endpoints, one per line"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-subtle">
            Hyperion history pool
          </span>
          <textarea
            className="h-36 w-full rounded-md border border-border bg-background p-2 font-mono text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            value={histText}
            onChange={(e) => setHistText(e.target.value)}
            spellCheck={false}
            aria-label="Hyperion history endpoints, one per line"
          />
        </label>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={save}>
          {saved ? <Check className="size-3.5" /> : <Save className="size-3.5" />}
          {saved ? "Saved" : "Save endpoints"}
        </Button>
        <Button size="sm" variant="outline" onClick={reset}>
          <RotateCcw className="size-3.5" />
          Defaults
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function InfraStatus() {
  const e = useMarketEngine();
  const [, force] = useState(0);
  // Keep block age / "synced Xs ago" live between engine commits.
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const blockAgeMs = e.headBlockAt > 0 ? Date.now() - e.headBlockAt : Number.POSITIVE_INFINITY;
  const blockFresh = blockAgeMs < 5_000;
  const chainLive = e.status === "running" || e.status === "resyncing";
  const timings = lastCycleTimings();
  const alcorAge = e.alcor.lastOkAt > 0 ? Date.now() - e.alcor.lastOkAt : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">Infrastructure</h2>
        <Badge variant={chainLive ? "leef" : "warn"}>
          {e.status === "running"
            ? "Engine running"
            : e.status === "resyncing"
              ? "Resyncing"
              : e.status === "degraded"
                ? "Degraded"
                : e.status}
        </Badge>
        {e.suspension && (
          <Badge variant="warn">
            resumed {timeAgo(new Date(e.suspension.lastResumeAt).toISOString())} after{" "}
            {(e.suspension.gapMs / 1000).toFixed(0)}s · resync #{e.suspension.resyncs}
          </Badge>
        )}
        <span className="ml-auto text-xs text-subtle">
          no page refresh · the engine outlives every component
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Chain">
          <div className="flex items-center gap-2 font-mono tabular-nums">
            <StatusDot ok={blockFresh} warn={!blockFresh} />
            <span className="text-fg">WAX MAINNET</span>
          </div>
          <div className="pl-4 text-muted-foreground">
            Head <span className="font-mono text-fg">{fmtNum(e.headBlock, { digits: 0 })}</span> ·
            LIB <span className="font-mono text-fg">{fmtNum(e.libBlock, { digits: 0 })}</span> ·
            age{" "}
            <span className={cn("font-mono", blockFresh ? "text-leef" : "text-warn")}>
              {Number.isFinite(blockAgeMs) ? `${(blockAgeMs / 1000).toFixed(1)}s` : "—"}
            </span>
          </div>
        </Section>

        <Section title="Market state">
          <div className="flex items-center gap-2 font-mono tabular-nums">
            <StatusDot ok={e.snapshot?.source === "live"} />
            <span className="text-fg">
              {e.snapshot?.source === "live" ? "Live book" : "Fallback book"}
            </span>
            <span className="text-muted-foreground">
              {e.lastFetchMs > 0 ? `${e.lastFetchMs.toFixed(0)}ms pull` : ""}
            </span>
          </div>
          <div className="pl-4 text-muted-foreground">
            Alcor API{" "}
            <span className={cn("font-mono", e.alcor.ok ? "text-leef" : "text-warn")}>
              {e.alcor.ok ? "ok" : "down"}
            </span>
            {alcorAge > 0 && ` · ${timeAgo(new Date(Date.now() - alcorAge).toISOString())}`}
            {e.snapshot?.spotAt && (
              <>
                {" · on-chain spot "}
                <span className="font-mono text-fg">
                  {e.onchainSpot.changed}/{e.onchainSpot.checked} pools
                </span>{" "}
                {timeAgo(e.snapshot.spotAt)}
              </>
            )}
          </div>
          <div className="pl-4 text-muted-foreground">
            Routes fresh{" "}
            <span className="font-mono text-fg">{e.routes.fresh}</span> · stale{" "}
            <span className="font-mono text-fg">{e.routes.stale}</span> · tracked{" "}
            <span className="font-mono text-fg">{e.routes.trackedPools}</span>
          </div>
        </Section>

        <Section title={`RPC pool (${e.rpc.length})`}>
          {e.rpc.map((r) => (
            <EndpointRow key={r.url} e={r} />
          ))}
          <p className="pt-1 text-[11px] text-subtle">
            score = success × freshness(block lag) × latency · “tx” = eligible for
            transaction broadcast (≤ {TRADING_MAX_BLOCK_LAG} blocks behind, clean chain id)
          </p>
        </Section>

        <Section title={`History pool — Hyperion (${e.history.length})`}>
          {e.history.map((r) => (
            <EndpointRow key={r.url} e={r} />
          ))}
          <p className="pt-1 text-[11px] text-subtle">
            History failure never stops trading — only reconciliation waits.
          </p>
        </Section>

        <Section title="Signer session">
          <div className="flex items-center gap-2 font-mono">
            <StatusDot ok={e.signer.ready} warn={e.signer.mode === "paper"} />
            <span className="text-fg">
              {e.signer.mode === "live"
                ? `READY · ${e.signer.account} · ${
                    e.signer.authType === "key"
                      ? "session key (in-memory)"
                      : e.signer.authType === "wcw"
                        ? "WAX Cloud Wallet"
                        : e.signer.authType === "anchor"
                          ? "Anchor"
                          : "wallet"
                  }`
                : "PAPER — no signer"}
            </span>
          </div>
          <p className="pl-4 text-[11px] text-subtle">
            Market refreshes never touch the signer. Raw keys live in memory only — a
            real page reload requires re-import by design.
          </p>
        </Section>

        <Section title="Automation">
          <div className="flex items-center gap-2 font-mono">
            <StatusDot ok={e.autoTrade.bot} warn={!e.autoTrade.bot} />
            <span className="text-fg">
              Auto trade {e.autoTrade.bot ? "ACTIVE" : "off"}
              {e.autoTrade.rebalancer && " · rebalancer on"}
            </span>
          </div>
          <div className="pl-4 text-muted-foreground">
            trade phase <span className="font-mono text-fg">{e.autoTrade.phase}</span>
            {e.autoTrade.phase === "unknown" && (
              <span className="text-warn"> — capital locked, never auto-retried</span>
            )}
          </div>
        </Section>

        <Section title="Engine cycle timings">
          <TimingRow label="market pull" ms={e.cycle.marketMs} />
          <TimingRow label="on-chain spot" ms={e.cycle.onchainMs} />
          <TimingRow label="balances" ms={e.cycle.balanceMs} />
          <TimingRow label="bot evaluate" ms={e.cycle.botMs} />
          <TimingRow label="total cycle" ms={e.cycle.totalCycleMs} />
        </Section>

        <Section title="Trade cycle timings (last live trade)">
          <TimingRow label="request queue" ms={timings.queueWaitMs} />
          <TimingRow label="network" ms={timings.networkMs} />
          <TimingRow label="JSON parse" ms={timings.parseMs} />
          <TimingRow label="price oracle" ms={timings.priceOracleMs} />
          <TimingRow label="route search" ms={timings.routeSearchMs} />
          <TimingRow label="size optimization" ms={timings.sizeOptimizationMs} />
          <TimingRow label="net edge" ms={timings.netEdgeMs} />
          <TimingRow label="risk / governor" ms={timings.riskMs} />
          <TimingRow label="quote" ms={timings.quoteMs} />
          <TimingRow label="exact-quote gate" ms={timings.quoteVerifyMs} />
          <TimingRow label="sign" ms={timings.signMs} />
          <TimingRow label="confirmation" ms={timings.confirmationMs} />
          <TimingRow label="total trade" ms={timings.totalTradeCycleMs} />
          <div className="flex items-center justify-between border-t border-border pt-1 font-mono">
            <span className="text-muted-foreground">candidates / routes / quotes</span>
            <span className="text-fg">
              {timings.candidateCount} / {timings.routeCount} / {timings.quoteCount}
            </span>
          </div>
        </Section>
      </div>

      <EndpointConfigEditor />

      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4 text-xs">
        {e.fetching ? (
          <Loader2 className="size-4 animate-spin text-accent" />
        ) : navigator.onLine ? (
          <Wifi className="size-4 text-leef" />
        ) : (
          <WifiOff className="size-4 text-sell" />
        )}
        <span className="text-muted-foreground">
          {navigator.onLine ? "Online" : "Offline — engine will resync on reconnect"}
          {e.lastError && <span className="text-warn"> · last error: {e.lastError}</span>}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => void marketEngine.forceResync()}
        >
          <RotateCcw className="size-3.5" />
          Force resync
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void marketEngine.forceRefresh()}
          disabled={e.fetching}
        >
          {e.fetching ? "Fetching…" : "Refresh book"}
        </Button>
      </div>
    </div>
  );
}
