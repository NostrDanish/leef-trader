import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Book-pull cadence. Live = 10s — fastest that stays polite to Alcor. */
export const MIN_SYNC_SEC = 10;
export const MAX_SYNC_SEC = 60;
export const DEFAULT_SYNC_SEC = 30;
export const SYNC_PRESETS = [
  { sec: 10, label: "Live" },
  { sec: 15, label: "15s" },
  { sec: 30, label: "30s" },
  { sec: 60, label: "60s" },
] as const;

export function clampSyncSec(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SYNC_SEC;
  return Math.min(MAX_SYNC_SEC, Math.max(MIN_SYNC_SEC, Math.round(n)));
}

export type TabId =
  | "overview"
  | "pools"
  | "pool"
  | "quotes"
  | "tick"
  | "il"
  | "tape"
  | "wallet"
  | "bot"
  | "portfolio"
  | "evidence"
  | "infra";

type TerminalState = {
  tab: TabId;
  selectedPoolId: number | null;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippage: number;
  poolQuery: string;
  poolSort:
    | "score"
    | "tvl"
    | "volume"
    | "reserve"
    | "price"
    | "fee"
    | "name"
    | "change"
    | "apy"
    | "turnover";
  poolDir: "asc" | "desc";
  tickPoolId: number | null;
  /** Seconds between authoritative market pulls. */
  syncSec: number;
  setTab: (tab: TabId) => void;
  selectPool: (id: number) => void;
  setSwap: (
    p: Partial<Pick<TerminalState, "tokenIn" | "tokenOut" | "amountIn" | "slippage">>,
  ) => void;
  flipSwap: () => void;
  setPoolQuery: (q: string) => void;
  setPoolSort: (k: TerminalState["poolSort"]) => void;
  togglePoolDir: () => void;
  setTickPool: (id: number | null) => void;
  setSyncSec: (sec: number) => void;
};

export const useTerminal = create<TerminalState>()(
  persist(
    (set, get) => ({
  tab: "tick",
  selectedPoolId: 217,
  tokenIn: "WAX",
  tokenOut: "LEEF",
  amountIn: "10",
  slippage: 0.5,
  poolQuery: "",
  poolSort: "tvl",
  poolDir: "desc",
  tickPoolId: 217,
  syncSec: DEFAULT_SYNC_SEC,
  setTab: (tab) => set({ tab }),
  selectPool: (id) => set({ selectedPoolId: id, tab: "pool" }),
  setSwap: (p) => set(p),
  flipSwap: () => {
    const { tokenIn, tokenOut, amountIn } = get();
    set({
      tokenIn: tokenOut,
      tokenOut: tokenIn,
      amountIn: tokenOut === "LEEF" && Number(amountIn) < 1000 ? "1000000" : "10",
    });
  },
  setPoolQuery: (q) => set({ poolQuery: q }),
  setPoolSort: (k) =>
    set((s) => ({
      poolSort: k,
      poolDir:
        s.poolSort === k ? (s.poolDir === "asc" ? "desc" : "asc") : k === "name" ? "asc" : "desc",
    })),
  togglePoolDir: () => set((s) => ({ poolDir: s.poolDir === "asc" ? "desc" : "asc" })),
  setTickPool: (id) => set({ tickPoolId: id }),
  setSyncSec: (sec) => set({ syncSec: clampSyncSec(sec) }),
    }),
    {
      name: "leef-terminal-sync",
      version: 1,
      partialize: (s) => ({ syncSec: s.syncSec }),
    },
  ),
);
