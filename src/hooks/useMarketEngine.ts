import { useEffect, useSyncExternalStore } from "react";
import type { EngineState } from "@/lib/market/market-engine";

/**
 * The trading engine (bot loop, signer, chain pools) is a dynamic import.
 * The shell evaluates and paints without waiting for that chunk; `boot`
 * starts the download as soon as this module is evaluated, then `start()`
 * runs when the chunk arrives. `start()` is idempotent.
 */
type Engine = typeof import("@/lib/market/market-engine").marketEngine;

const PLACEHOLDER: EngineState = {
  status: "starting",
  startedAt: 0,
  version: 0,
  snapshot: null,
  fetching: true,
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
  cycle: { marketMs: 0, onchainMs: 0, balanceMs: 0, botMs: 0, totalCycleMs: 0 },
  suspension: null,
  endpoints: { rpc: [], history: [] },
};

let current: EngineState = PLACEHOLDER;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot(): EngineState {
  return current;
}

let bootPromise: Promise<Engine> | null = null;

export function bootMarketEngine(): Promise<Engine> {
  bootPromise ??= import("@/lib/market/market-engine").then((mod) => {
    const engine = mod.marketEngine;
    engine.subscribe(() => {
      current = engine.getState();
      emit();
    });
    current = engine.getState();
    emit();
    engine.start();
    return engine;
  });
  return bootPromise;
}

// Production: start the download during module init so it races first paint
// instead of waiting for a passive effect. Tests boot from the hook so a
// bare import of this module does not start timers.
if (import.meta.env.MODE !== "test") {
  void bootMarketEngine();
}

export function useMarketEngine(): EngineState {
  useEffect(() => {
    void bootMarketEngine();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
