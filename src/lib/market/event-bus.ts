/**
 * Minimal typed event bus for the market engine. React never drives the
 * trading loop; interested modules (and the engine's own subsystems) talk
 * through these events instead.
 */
import type { LeefSnapshot } from "@/lib/leef/types";

export type MarketEvents = {
  /** New head block observed (the chain heartbeat). */
  block: { headBlock: number; libBlock: number };
  /** A fresh (or patched) market snapshot is available. */
  snapshot: { snap: LeefSnapshot };
  /** Pool state changed — routes depending on these pools are invalid. */
  pools: { changedIds: number[]; headBlock: number };
  /** Wallet balances/resources refreshed. */
  balances: { account: string };
  /** Provider health changed (RPC / history pools). */
  health: Record<string, never>;
  /** The browser was suspended and the engine resynced. */
  resume: { gapMs: number };
  /** Swap-flow rolling state refreshed (E-1 logswap stream, market data). */
  flow: { states: import("./swap-flow").PoolFlowState[] };
};

type Handler<K extends keyof MarketEvents> = (payload: MarketEvents[K]) => void;

export class EventBus {
  private handlers = new Map<keyof MarketEvents, Set<Handler<never>>>();

  on<K extends keyof MarketEvents>(key: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(fn as Handler<never>);
    return () => {
      set?.delete(fn as Handler<never>);
    };
  }

  emit<K extends keyof MarketEvents>(key: K, payload: MarketEvents[K]): void {
    const set = this.handlers.get(key);
    if (!set) return;
    for (const fn of set) {
      try {
        (fn as Handler<K>)(payload);
      } catch {
        /* a broken listener must not break the engine */
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

export const marketBus = new EventBus();
