import { create } from "zustand";
import type { IndicatorId } from "@/lib/leef/indicators";
import { DEFAULT_TICK_PARAMS, type TickKnobs } from "@/lib/leef/tick-engine";

export type TabId =
  | "overview"
  | "pools"
  | "pool"
  | "quotes"
  | "tick"
  | "il"
  | "tape"
  | "wallet"
  | "autoswap";

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
  tick: TickKnobs;
  tickPaused: boolean;
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
  setTick: (p: Partial<TickKnobs>) => void;
  toggleEngine: (id: IndicatorId) => void;
  resetTick: () => void;
  setTickPaused: (v: boolean) => void;
};

export const useTerminal = create<TerminalState>()((set, get) => ({
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
  tick: { ...DEFAULT_TICK_PARAMS, engines: { ...DEFAULT_TICK_PARAMS.engines } },
  tickPaused: false,
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
  setTick: (p) =>
    set((s) => ({
      tick: {
        ...s.tick,
        ...p,
        engines: p.engines ? { ...p.engines } : s.tick.engines,
      },
    })),
  toggleEngine: (id) =>
    set((s) => ({
      tick: {
        ...s.tick,
        engines: { ...s.tick.engines, [id]: !s.tick.engines[id] },
      },
    })),
  resetTick: () =>
    set({
      tick: { ...DEFAULT_TICK_PARAMS, engines: { ...DEFAULT_TICK_PARAMS.engines } },
      tickPaused: false,
    }),
  setTickPaused: (v) => set({ tickPaused: v }),
}));
