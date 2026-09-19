/**
 * MarketEngine — the persistent Antelope trading engine with a React
 * terminal attached (not the other way around).
 *
 *   website loads once
 *     → wallet/key session initialized (independent of market data)
 *     → background engine starts
 *     → head-block heartbeat (chain is the clock)
 *     → Alcor API pulls + swap.alcor table reads between them
 *     → prices recalculated → routes invalidated per dependency
 *     → strategies reevaluate → trade if conditions pass
 *     → balances update → UI reacts
 *
 * NO page refresh. NO re-importing the key because the market changed.
 * The engine is a module singleton: it owns its timers, survives React
 * mount/unmount, and only dies with the tab.
 *
 * Browser suspension (background tab, screen lock, network loss) is handled
 * explicitly: on wake the engine detects the gap, resyncs from chain truth,
 * discards stale routes, and only then resumes trading.
 */
import { attachUsdPrices } from "@/lib/leef/parse";
import { getLeefSnapshot } from "@/lib/leef/snapshot";
import type { AuxPool, LeefPool, LeefSnapshot } from "@/lib/leef/types";
import {
  applyOnchainToAuxPool,
  applyOnchainToLeefPool,
  fetchOnchainPools,
  onchainDiffers,
  type OnchainPool,
} from "@/lib/wax/alcor-onchain";
import { journal } from "@/lib/leef/journal";
import { headInfo } from "@/lib/wallet/chain";
import { hasSecret } from "@/lib/wallet/secret";
import { hasWalletSession } from "@/lib/wallet/session";
import { tradePhase, type TradePhase } from "@/lib/wallet/trade-cycle";
import { rpcPool, historyPool, type EndpointHealth } from "@/lib/wax/provider-pool";
import { effectiveEndpoints, type EndpointConfig } from "@/lib/wax/endpoints";
import { useBot } from "@/store/bot";
import { usePortfolio } from "@/store/portfolio";
import { clampSyncSec, DEFAULT_SYNC_SEC, useTerminal } from "@/store/terminal";
import { useWallet } from "@/store/wallet";
import { botOnSnapshot } from "@/components/terminal/use-bot-loop";
import { rebalancerOnSnapshot } from "@/components/terminal/use-portfolio-loop";
import { syncWalletBalances } from "@/components/terminal/use-wallet-sync";
import { marketBus } from "./event-bus";
import { hotPoolIds } from "./execution-state";
import { routeCache } from "./route-cache";
import { checkpointDrift, latestCheckpoints, swapFlow } from "./swap-flow";

/* ------------------------------------------------------------------ */
/* engine state (immutable snapshot object for React)                   */
/* ------------------------------------------------------------------ */

export type EngineStatus = "stopped" | "starting" | "running" | "resyncing" | "degraded";

export type EngineCycleTimings = {
  marketMs: number;
  onchainMs: number;
  balanceMs: number;
  botMs: number;
  totalCycleMs: number;
};

export type EngineState = {
  status: EngineStatus;
  startedAt: number;
  /** Bumped on every state change — React re-renders on this. */
  version: number;
  snapshot: LeefSnapshot | null;
  fetching: boolean;
  lastFetchAt: number;
  lastFetchMs: number;
  lastError: string | null;
  headBlock: number;
  libBlock: number;
  headBlockAt: number;
  blockAgeMs: number;
  rpc: EndpointHealth[];
  history: EndpointHealth[];
  bestRpcUrl: string | null;
  alcor: { ok: boolean; lastOkAt: number; latencyMs: number };
  onchainSpot: { at: number; checked: number; changed: number; ok: boolean };
  routes: { fresh: number; stale: number; trackedPools: number };
  signer: {
    mode: "paper" | "live";
    ready: boolean;
    account: string;
    authType: "key" | "wcw" | "anchor" | null;
  };
  autoTrade: { bot: boolean; rebalancer: boolean; phase: TradePhase };
  cycle: EngineCycleTimings;
  suspension: { lastResumeAt: number; gapMs: number; resyncs: number } | null;
  endpoints: EndpointConfig;
};

const emptyCycle = (): EngineCycleTimings => ({
  marketMs: 0,
  onchainMs: 0,
  balanceMs: 0,
  botMs: 0,
  totalCycleMs: 0,
});

function initialState(): EngineState {
  const { rpc, history } = effectiveEndpoints();
  return {
    status: "stopped",
    startedAt: 0,
    version: 0,
    snapshot: null,
    fetching: false,
    lastFetchAt: 0,
    lastFetchMs: 0,
    lastError: null,
    headBlock: 0,
    libBlock: 0,
    headBlockAt: 0,
    blockAgeMs: Number.POSITIVE_INFINITY,
    rpc: [],
    history: [],
    bestRpcUrl: null,
    alcor: { ok: false, lastOkAt: 0, latencyMs: 0 },
    onchainSpot: { at: 0, checked: 0, changed: 0, ok: false },
    routes: { fresh: 0, stale: 0, trackedPools: 0 },
    signer: { mode: "paper", ready: false, account: "paper.leef", authType: null },
    autoTrade: { bot: false, rebalancer: false, phase: "idle" },
    cycle: emptyCycle(),
    suspension: null,
    endpoints: {
      rpc: rpc.map((e) => e.url),
      history: history.map((e) => e.url),
    },
  };
}

/* ------------------------------------------------------------------ */
/* the engine                                                           */
/* ------------------------------------------------------------------ */

const HEARTBEAT_MS = 1_500;
/** On-chain pool spot refresh cadence (swap.alcor table reads). */
const SPOT_EVERY_N_HEARTBEATS = 3; // ~4.5s between API pulls
/** Swap-flow (Hyperion logswap) poll cadence — one history call per ~10s. */
const FLOW_EVERY_N_HEARTBEATS = 7;
/** A head block older than this (ms) means our view of the chain stalled. */
const BLOCK_STALL_MS = 20_000;
/** Gap after which a wake/resume forces a full resync. */
const RESUME_GAP_FACTOR = 2.5;

class MarketEngine {
  private state: EngineState = initialState();
  private listeners = new Set<() => void>();
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private marketTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatCount = 0;
  private marketInflight = false;
  private spotInflight = false;
  /** Wall-clock of the last successful hot-pool table read (checkpoint guard). */
  private lastSpotRowsAt = 0;
  private lastTickAt = 0;
  private started = false;

  /* ------------------------- React interface ----------------------- */

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): EngineState => this.state;

  private commit(patch: Partial<EngineState>): void {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 };
    for (const fn of this.listeners) fn();
  }

  /* ---------------------------- lifecycle -------------------------- */

  /** Idempotent — the terminal calls this once on mount; the engine persists. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (import.meta.env.MODE === "test") {
      // Unit tests: expose the state surface without timers or network —
      // the engine's moving parts are covered by their own unit tests.
      this.commit({ status: "running", startedAt: Date.now() });
      return;
    }
    this.commit({
      status: "starting",
      startedAt: Date.now(),
      rpc: rpcPool.health(),
      history: historyPool.health(),
    });
    this.scheduleHeartbeat(0);
    this.scheduleMarket(200);
    this.watchSuspension();
  }

  stop(): void {
    this.started = false;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.marketTimer) clearTimeout(this.marketTimer);
    this.heartbeatTimer = null;
    this.marketTimer = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("focus", this.onFocus);
    this.commit({ status: "stopped" });
  }

  /* ---------------------------- heartbeat -------------------------- */

  private scheduleHeartbeat(delayMs: number): void {
    if (!this.started) return;
    // Never leave a previous heartbeat pending — onWake/forceResync would
    // otherwise spawn duplicate self-perpetuating heartbeat chains.
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    const expected = Date.now() + delayMs;
    this.heartbeatTimer = setTimeout(() => {
      // Timer drift = the browser throttled/suspended us. Detect the gap.
      const drift = Date.now() - expected;
      if (drift > HEARTBEAT_MS * 4) this.onWake(drift);
      void this.heartbeat();
    }, delayMs);
  }

  private async heartbeat(): Promise<void> {
    const t0 = Date.now();
    this.lastTickAt = t0;
    this.heartbeatCount += 1;
    try {
      const info = await headInfo();
      const changed =
        info.headBlock !== this.state.headBlock || info.libBlock !== this.state.libBlock;
      if (changed) {
        marketBus.emit("block", { headBlock: info.headBlock, libBlock: info.libBlock });
      }
      this.commit({
        status: this.state.status === "stopped" ? "stopped" : "running",
        headBlock: info.headBlock,
        libBlock: info.libBlock,
        headBlockAt: Date.now(),
        blockAgeMs: 0,
        rpc: rpcPool.health(),
        history: historyPool.health(),
        bestRpcUrl: rpcPool.best()?.url ?? null,
        routes: routeCache.stats(),
        signer: this.signerView(),
        autoTrade: this.autoTradeView(),
      });
    } catch {
      // No RPC answered — keep the last head; age grows until the UI shows it.
      this.commit({
        status: "degraded",
        blockAgeMs: Date.now() - this.state.headBlockAt,
        rpc: rpcPool.health(),
        history: historyPool.health(),
        bestRpcUrl: rpcPool.best()?.url ?? null,
        routes: routeCache.stats(),
        signer: this.signerView(),
        autoTrade: this.autoTradeView(),
      });
    }
    // Health-probe cooled endpoints back to life (~every 6s).
    if (this.heartbeatCount % 4 === 0) {
      void rpcPool.probe();
      void historyPool.probe();
    }
    // On-chain spot refresh between API pulls (block-driven prices).
    if (this.heartbeatCount % SPOT_EVERY_N_HEARTBEATS === 0 && !document.hidden) {
      void this.onchainSpot();
    }
    // Swap-flow poll (E-1) — the service itself enforces hidden-tab pause,
    // backoff and single-flight, so this call is always cheap.
    if (this.heartbeatCount % FLOW_EVERY_N_HEARTBEATS === 0) {
      void this.flowPoll();
    }
    // Chain stalled while we think we're live → force a market pull.
    const headAge = Date.now() - this.state.headBlockAt;
    if (headAge > BLOCK_STALL_MS && this.state.status === "running") {
      this.scheduleMarket(0);
    }
    const beat = Date.now() - t0;
    this.scheduleHeartbeat(Math.max(250, HEARTBEAT_MS - beat));
  }

  /* --------------------------- market loop ------------------------- */

  private scheduleMarket(delayMs: number): void {
    if (!this.started) return;
    if (this.marketTimer) clearTimeout(this.marketTimer);
    this.marketTimer = setTimeout(() => void this.marketCycle(), delayMs);
  }

  private cadenceMs(): number {
    return clampSyncSec(useTerminal.getState().syncSec ?? DEFAULT_SYNC_SEC) * 1000;
  }

  private async marketCycle(): Promise<void> {
    if (!this.started) return;
    const t0 = Date.now();
    const cycle: EngineCycleTimings = { ...emptyCycle() };
    if (!this.marketInflight) {
      this.marketInflight = true;
      this.commit({ fetching: true });
      try {
        const tM = Date.now();
        const snap = await getLeefSnapshot();
        cycle.marketMs = Date.now() - tM;
        const alcorOk = snap.source === "live";
        const changedPoolIds = routeCache.notePools(snap.pools);
        if (changedPoolIds.length > 0) {
          marketBus.emit("pools", { changedIds: changedPoolIds, headBlock: this.state.headBlock });
        }
        this.commit({
          snapshot: snap,
          fetching: false,
          lastFetchAt: Date.now(),
          lastFetchMs: cycle.marketMs,
          lastError: null,
          alcor: {
            ok: alcorOk,
            lastOkAt: alcorOk ? Date.now() : this.state.alcor.lastOkAt,
            latencyMs: cycle.marketMs,
          },
          cycle: { ...cycle, totalCycleMs: Date.now() - t0 },
        });
        marketBus.emit("snapshot", { snap });

        // Stale-market gate: never trade from a book older than the cadence
        // window allows (e.g. right after a long suspension).
        const ageMs = Date.now() - (Date.parse(snap.fetchedAt) || Date.now());
        const maxAgeMs = this.cadenceMs() + 15_000;
        if (snap.source === "live" && ageMs <= maxAgeMs) {
          // Balances refresh without blocking the strategy cycle (the bot
          // sizes from the wallet store, which lands a moment later).
          const tB = Date.now();
          void syncWalletBalances(snap).finally(() => {
            this.commit({ cycle: { ...this.state.cycle, balanceMs: Date.now() - tB } });
          });
          const tBot = Date.now();
          // One scheduler lane: profit/strategy evaluates first. Maintenance
          // only gets a turn after that decision settles and the shared
          // capital lock is known idle.
          await botOnSnapshot(snap);
          rebalancerOnSnapshot(snap);
          cycle.botMs = Date.now() - tBot;
          this.commit({
            cycle: { ...cycle, totalCycleMs: Date.now() - t0 },
            signer: this.signerView(),
            autoTrade: this.autoTradeView(),
          });
        } else if (snap.source === "live" && ageMs > maxAgeMs && useBot.getState().running) {
          useBot
            .getState()
            .setLastReason(
              `Market book is ${(ageMs / 1000).toFixed(0)}s old — not trading from stale data`,
            );
        }
        // Fresh snapshot → re-run the spot patcher against the new pools.
        void this.onchainSpot();
      } catch (err) {
        this.commit({
          fetching: false,
          lastError: err instanceof Error ? err.message : "market fetch failed",
          status: "degraded",
        });
      } finally {
        this.marketInflight = false;
      }
    }
    this.scheduleMarket(this.cadenceMs());
  }

  /* ------------------- on-chain spot (chain truth) ------------------ */

  /** HOT pools re-read straight from swap.alcor between API pulls. */
  private async onchainSpot(): Promise<void> {
    const snap = this.state.snapshot;
    if (!snap || snap.source !== "live" || this.spotInflight || !this.started) return;
    this.spotInflight = true;
    const t0 = Date.now();
    try {
      const hot = this.hotPoolIds(snap);
      if (hot.length === 0) return;
      const rows = await fetchOnchainPools(hot);
      this.lastSpotRowsAt = Date.now();
      // E-1: each logswap checkpoint is validated ONCE against the first real
      // table read that supersedes it; mismatches are journaled (rate-limited)
      // — the checkpoint stream must prove consistent before it is trusted.
      for (const [id, row] of rows) {
        const cp = swapFlow.checkpointFor(id);
        if (!cp || cp.source !== "logswap") continue;
        const mm = checkpointDrift(cp.row, row);
        swapFlow.noteTableRow(row);
        if (mm && swapFlow.shouldJournalMismatch(id, Date.now())) {
          journal({
            kind: "flow",
            reason:
              `logswap checkpoint pool ${id} vs table read:` +
              ` sqrt ${mm.sqrtDriftPct.toFixed(2)}% · liq ${mm.liquidityDriftPct.toFixed(2)}%` +
              ` · reserves ${mm.reserveDriftPct.toFixed(2)}%`,
            poolIds: [id],
          });
        }
      }
      const patched = this.patchPools(snap, rows, true);
      const changed = patched.changed;
      const nextLeef = patched.nextLeef;
      const nextAux = patched.nextAux;
      if (changed > 0) {
        // Recompute USD prices over the patched book (trusted-stable oracle
        // included) — this is what makes prices move BETWEEN API pulls.
        const px = attachUsdPrices(nextLeef, nextAux, snap.waxUsd, undefined);
        const changedIds = routeCache.notePools(nextLeef);
        const patchedSnap: LeefSnapshot = {
          ...snap,
          pools: nextLeef,
          aux: nextAux,
          spotAt: new Date().toISOString(),
          waxUsd: px.waxUsd,
          leefUsd: px.leefUsd,
          waxPerLeef: px.waxPerLeef,
        };
        this.commit({
          snapshot: patchedSnap,
          onchainSpot: { at: Date.now(), checked: rows.size, changed, ok: true },
          routes: routeCache.stats(),
          cycle: { ...this.state.cycle, onchainMs: Date.now() - t0 },
        });
        marketBus.emit("pools", { changedIds, headBlock: this.state.headBlock });
        marketBus.emit("snapshot", { snap: patchedSnap });
        // Strategies reevaluate on chain-truth changes too (staleness gated).
        const ageMs = Date.now() - (Date.parse(snap.fetchedAt) || Date.now());
        if (ageMs <= this.cadenceMs() + 15_000) {
          // Same single lane for chain-spot updates: settle profit selection
          // before maintenance is allowed to inspect/spend inventory.
          void botOnSnapshot(patchedSnap).then(() => rebalancerOnSnapshot(patchedSnap));
        }
      } else {
        this.commit({
          onchainSpot: { at: Date.now(), checked: rows.size, changed: 0, ok: true },
          cycle: { ...this.state.cycle, onchainMs: Date.now() - t0 },
        });
      }
    } catch {
      this.commit({
        onchainSpot: { ...this.state.onchainSpot, at: Date.now(), ok: false },
        cycle: { ...this.state.cycle, onchainMs: Date.now() - t0 },
      });
    } finally {
      this.spotInflight = false;
    }
  }

  /** Pools the router actually needs: the ONE shared hot-pool definition. */
  private hotPoolIds(snap: LeefSnapshot): number[] {
    return hotPoolIds(snap);
  }

  /**
   * Apply fresh on-chain rows (table reads OR logswap checkpoints) to the
   * snapshot's pool arrays. `dropInvalid` (table truth only) removes delisted
   * pools; checkpoints never remove — a swap just proved the pool is live.
   */
  private patchPools(
    snap: LeefSnapshot,
    rows: Map<number, OnchainPool>,
    dropInvalid: boolean,
  ): { nextLeef: LeefPool[]; nextAux: AuxPool[]; changed: number } {
    const leefById = new Map(snap.pools.map((p) => [p.id, p]));
    const auxById = new Map(snap.aux.map((p) => [p.id, p]));
    let changed = 0;
    const nextLeef: LeefPool[] = [...snap.pools];
    const nextAux: AuxPool[] = [...snap.aux];
    for (const [id, oc] of rows) {
      const leef = leefById.get(id);
      if (leef) {
        const differs = onchainDiffers(
          {
            sqrtPriceX64: leef.sqrtPriceX64,
            liquidity: leef.liquidity,
            qtyA: leef.leefIsA ? leef.leef.quantity : leef.pair.quantity,
            qtyB: leef.leefIsA ? leef.pair.quantity : leef.leef.quantity,
          },
          oc,
        );
        if (!differs) continue;
        const patched = applyOnchainToLeefPool(leef, oc);
        const idx = nextLeef.findIndex((p) => p.id === id);
        if (patched && idx >= 0) {
          nextLeef[idx] = patched;
          changed += 1;
        } else if (idx >= 0 && dropInvalid) {
          nextLeef.splice(idx, 1); // pool delisted on-chain
          changed += 1;
        }
        continue;
      }
      const aux = auxById.get(id);
      if (aux) {
        const patched = applyOnchainToAuxPool(aux, oc);
        const idx = nextAux.findIndex((p) => p.id === id);
        if (patched && idx >= 0) nextAux[idx] = patched;
      }
    }
    return { nextLeef, nextAux, changed };
  }

  /* ------------------- swap flow (E-1 logswap stream) --------------- */

  /**
   * One logswap poll pass (~every 7th heartbeat ≈ 10 s): refresh the rolling
   * per-pool flow state, publish it on the bus, and patch the free post-swap
   * checkpoints into the hot pools between table reads (routeCache versions
   * bump through the normal notePools path). Deliberately does NOT re-run
   * strategies — flow is market data; entries still come from the normal
   * snapshot/spot cadence. Checkpoints are validated against the next table
   * read inside onchainSpot().
   */
  private async flowPoll(): Promise<void> {
    const snap = this.state.snapshot;
    if (!snap || snap.source !== "live" || !this.started) return;
    const events = await swapFlow.poll();
    if (!events) return; // hidden tab / backoff / single-flight / failed
    swapFlow.track(events, snap);
    marketBus.emit("flow", { states: swapFlow.tracker.allStates(Date.now()) });
    if (events.length === 0) return;
    // Ignore checkpoints older than the last chain-truth read (they would
    // regress pool state the table already superseded). 3s covers block
    // timestamp vs receipt-time skew.
    const fresh = events.filter((e) => e.at >= this.lastSpotRowsAt - 3_000);
    const cps = latestCheckpoints(fresh, snap, this.hotPoolIds(snap));
    if (cps.length === 0) return;
    swapFlow.noteCheckpoints(cps);
    const { nextLeef, nextAux, changed } = this.patchPools(
      snap,
      new Map(cps.map((c) => [c.id, c])),
      false,
    );
    if (changed === 0) return;
    const px = attachUsdPrices(nextLeef, nextAux, snap.waxUsd, undefined);
    const changedIds = routeCache.notePools(nextLeef);
    const patchedSnap: LeefSnapshot = {
      ...snap,
      pools: nextLeef,
      aux: nextAux,
      spotAt: new Date().toISOString(),
      waxUsd: px.waxUsd,
      leefUsd: px.leefUsd,
      waxPerLeef: px.waxPerLeef,
    };
    this.commit({ snapshot: patchedSnap, routes: routeCache.stats() });
    if (changedIds.length > 0) {
      marketBus.emit("pools", { changedIds, headBlock: this.state.headBlock });
    }
    marketBus.emit("snapshot", { snap: patchedSnap });
  }

  /* ---------------------- suspension & resume ---------------------- */

  private watchSuspension(): void {
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("focus", this.onFocus);
  }

  private onVisibility = (): void => {
    if (document.visibilityState === "visible") this.onWake(0);
  };
  private onOnline = (): void => {
    this.onWake(0);
  };
  private onFocus = (): void => {
    this.onWake(0);
  };

  /**
   * The browser woke up (or came back online). If meaningful time passed,
   * resync from chain truth: fresh head block, fresh snapshot, fresh
   * balances — and DISCARD every cached route (stale data never trades).
   * While hidden and under 5 minutes, we just mark time (timers are throttled
   * anyway) instead of burning requests in a background tab.
   */
  private onWake(driftMs: number): void {
    if (!this.started) return;
    const gapMs = Math.max(driftMs, this.lastTickAt > 0 ? Date.now() - this.lastTickAt : 0);
    const threshold = this.cadenceMs() * RESUME_GAP_FACTOR;
    if (gapMs < threshold) return; // short blip — timers catch up on their own
    const visible = document.visibilityState === "visible";
    if (!visible && gapMs < 5 * 60_000) {
      this.lastTickAt = Date.now();
      return;
    }
    routeCache.invalidateAll();
    this.commit({
      status: "resyncing",
      suspension: {
        lastResumeAt: Date.now(),
        gapMs,
        resyncs: (this.state.suspension?.resyncs ?? 0) + 1,
      },
      routes: routeCache.stats(),
    });
    marketBus.emit("resume", { gapMs });
    this.scheduleHeartbeat(0);
    this.scheduleMarket(0);
    const snap = this.state.snapshot;
    if (snap) void syncWalletBalances(snap);
  }

  /* ------------------------------ views ---------------------------- */

  private signerView(): EngineState["signer"] {
    const w = useWallet.getState();
    const live = w.mode === "live" && w.canSign();
    return {
      mode: w.mode,
      ready: live || hasWalletSession() || hasSecret(),
      account: w.account,
      authType: w.authType,
    };
  }

  private autoTradeView(): EngineState["autoTrade"] {
    return {
      bot: useBot.getState().running,
      rebalancer: usePortfolio.getState().running,
      phase: tradePhase(),
    };
  }

  /* ---------------------------- public API ------------------------- */

  /** Manual refresh button — pulls a fresh snapshot immediately. */
  async forceRefresh(): Promise<void> {
    this.scheduleMarket(0);
  }

  /** Force a full resync (chain truth first, routes discarded). */
  async forceResync(): Promise<void> {
    if (!this.started) return;
    routeCache.invalidateAll();
    this.commit({ status: "resyncing", routes: routeCache.stats() });
    this.scheduleHeartbeat(0);
    this.scheduleMarket(0);
    void rpcPool.probeAll();
    void historyPool.probeAll();
    const snap = this.state.snapshot;
    if (snap) void syncWalletBalances(snap);
  }

  /** Reload endpoint pools after a config change. */
  reloadEndpoints(): void {
    rpcPool.reload();
    historyPool.reload();
    const { rpc, history } = effectiveEndpoints();
    this.commit({
      endpoints: { rpc: rpc.map((e) => e.url), history: history.map((e) => e.url) },
      rpc: rpcPool.health(),
      history: historyPool.health(),
    });
  }

  /** Latest snapshot (or null before the first pull lands). */
  snapshot(): LeefSnapshot | null {
    return this.state.snapshot;
  }
}

export const marketEngine = new MarketEngine();
