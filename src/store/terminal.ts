import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_AI_GATEWAY } from "@/lib/leef/ai-analyst";

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
  | "ai"
  | "infra";

type TerminalState = {
  tab: TabId;
  selectedPoolId: number | null;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippage: number;
  /** Manual swap: graph depth cap (1–10). */
  swapMaxHops: number;
  /** Manual swap: pinned route path signature (kind+poolIds). null = auto/best. */
  selectedRouteSig: string | null;
  /** AI analyst master switch — off = zero calls to the gateway. */
  aiEnabled: boolean;
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
  /** AI analyst gateway (Leef-signer worker). Advisory only — never trades. */
  aiGatewayUrl: string;
  setTab: (tab: TabId) => void;
  selectPool: (id: number) => void;
  setSwap: (
    p: Partial<Pick<TerminalState, "tokenIn" | "tokenOut" | "amountIn" | "slippage">>,
  ) => void;
  setSwapMaxHops: (n: number) => void;
  selectRoute: (id: string | null) => void;
  setAiEnabled: (on: boolean) => void;
  flipSwap: () => void;
  setPoolQuery: (q: string) => void;
  setPoolSort: (k: TerminalState["poolSort"]) => void;
  togglePoolDir: () => void;
  setTickPool: (id: number | null) => void;
  setSyncSec: (sec: number) => void;
  setAiGatewayUrl: (url: string) => void;
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
  swapMaxHops: 4,
  selectedRouteSig: null,
  aiEnabled: true,
  poolQuery: "",
  poolSort: "tvl",
  poolDir: "desc",
  tickPoolId: 217,
  syncSec: DEFAULT_SYNC_SEC,
  aiGatewayUrl: DEFAULT_AI_GATEWAY,
  setTab: (tab) => set({ tab }),
  selectPool: (id) => set({ selectedPoolId: id, tab: "pool" }),
  // Route pins are pair-specific: changing the swap inputs invalidates the
  // pinned path.
  setSwap: (p) => set({ ...p, selectedRouteSig: null }),
  flipSwap: () => {
    const { tokenIn, tokenOut, amountIn } = get();
    set({
      tokenIn: tokenOut,
      tokenOut: tokenIn,
      amountIn: tokenOut === "LEEF" && Number(amountIn) < 1000 ? "1000000" : "10",
      selectedRouteSig: null,
    });
  },
  setSwapMaxHops: (n) =>
    set({ swapMaxHops: Math.min(10, Math.max(1, Math.round(n))), selectedRouteSig: null }),
  selectRoute: (selectedRouteSig) => set({ selectedRouteSig }),
  setAiEnabled: (aiEnabled) => set({ aiEnabled }),
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
  setAiGatewayUrl: (url) =>
    set({ aiGatewayUrl: url.trim().replace(/\/+$/, "") || DEFAULT_AI_GATEWAY }),
    }),
    {
      name: "leef-terminal-sync",
      version: 1,
      partialize: (s) => ({
        syncSec: s.syncSec,
        aiGatewayUrl: s.aiGatewayUrl,
        swapMaxHops: s.swapMaxHops,
        aiEnabled: s.aiEnabled,
      }),
    },
  ),
);
