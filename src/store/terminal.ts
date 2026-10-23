import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_AI_GATEWAY } from "@/lib/leef/ai-analyst";
import type { AiProposal } from "@/lib/leef/ai-executor";
import { setLearningModeProvider } from "@/lib/leef/learning-store";

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
  | "infra"
  | "sat"
  | "about";

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
  /**
   * Jev (System One) execution authority. Default OFF = zero Jev calls.
   * "suggest" = proposals surface on the AI desk only. "control" = a fresh
   * proposal at/above the confidence floor becomes an execution candidate
   * through the unchanged risk gauntlet. Persisted; granting "control"
   * requires the explicit confirm step (UI risk dialog → confirmed: true).
   */
  aiControl: "off" | "suggest" | "control";
  /** Latest Jev proposal for the AI desk (ephemeral — never persisted). */
  aiProposal: AiProposal | null;
  /**
   * Swap-flow danger guard (audit E-1) kill-switch. When ON, Hyperion logswap
   * flow may RAISE the danger score (veto/size-down entries); it never
   * creates an entry. OFF = flow is panel-only market data.
   */
  flowGuardEnabled: boolean;
  /**
   * Learning mode: SUGGEST = artifacts shadow until a human promotes;
   * CONTROLLED = the deterministic governor may auto-promote proven artifacts.
   */
  learningMode: "suggest" | "controlled";
  /** Auto evidence review cadence: the AI reviews every N trades (5/10/20). */
  aiReviewEveryTrades: number;
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
  /**
   * Set the Jev execution authority. "control" is refused unless
   * `confirmed === true` (the UI risk-confirm dialog) — returns whether the
   * mode was applied. Leaving "control" never requires confirmation.
   */
  setAiControl: (mode: "off" | "suggest" | "control", confirmed?: boolean) => boolean;
  setAiProposal: (p: AiProposal | null) => void;
  setFlowGuardEnabled: (on: boolean) => void;
  setLearningMode: (mode: "suggest" | "controlled") => void;
  setAiReviewEveryTrades: (n: number) => void;
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
  tab: "overview",
  selectedPoolId: 217,
  tokenIn: "WAX",
  tokenOut: "LEEF",
  amountIn: "10",
  slippage: 0.5,
  swapMaxHops: 4,
  selectedRouteSig: null,
  aiEnabled: true,
  aiControl: "off",
  aiProposal: null,
  flowGuardEnabled: true,
  learningMode: "suggest",
  aiReviewEveryTrades: 8,
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
  setAiControl: (mode, confirmed) => {
    if (mode === "control" && get().aiControl !== "control" && confirmed !== true) {
      return false; // explicit risk-confirm required to grant control
    }
    // A stale proposal must never outlive the mode that produced it.
    set(mode === get().aiControl ? { aiControl: mode } : { aiControl: mode, aiProposal: null });
    return true;
  },
  setAiProposal: (aiProposal) => set({ aiProposal }),
  setFlowGuardEnabled: (flowGuardEnabled) => set({ flowGuardEnabled }),
  setLearningMode: (learningMode) => set({ learningMode }),
  setAiReviewEveryTrades: (n) =>
    set({ aiReviewEveryTrades: Math.min(50, Math.max(3, Math.round(n))) }),
  setPoolQuery: (poolQuery) => set({ poolQuery }),
  setPoolSort: (poolSort) => set({ poolSort }),
  togglePoolDir: () => set({ poolDir: get().poolDir === "asc" ? "desc" : "asc" }),
  setTickPool: (tickPoolId) => set({ tickPoolId }),
  setSyncSec: (sec) => set({ syncSec: clampSyncSec(sec) }),
  setAiGatewayUrl: (aiGatewayUrl) => set({ aiGatewayUrl }),
    }),
    {
      name: "leef-terminal-sync",
      version: 2,
      // v1 → v2: aiControl is new. The safe default is ALWAYS "off" — the
      // legacy aiEnabled flag gated only the advisory analyst gateway and
      // must never imply execution authority.
      migrate: (persisted) => ({ ...(persisted as object), aiControl: "off" }),
      partialize: (s) => ({
        syncSec: s.syncSec,
        aiGatewayUrl: s.aiGatewayUrl,
        swapMaxHops: s.swapMaxHops,
        aiEnabled: s.aiEnabled,
        aiControl: s.aiControl,
        flowGuardEnabled: s.flowGuardEnabled,
        learningMode: s.learningMode,
        aiReviewEveryTrades: s.aiReviewEveryTrades,
      }),
    },
  ),
);

// The learning store stays import-light (lib layer must not import stores);
// it reads the mode through this provider.
setLearningModeProvider(() => useTerminal.getState().learningMode);
