import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_LADDER,
  DEFAULT_REBALANCE,
  type RebalanceSettings,
} from "@/lib/leef/rebalance";

export type PortfolioLogEntry = {
  id: string;
  t: string;
  mode: "paper" | "live";
  status: "filled" | "failed" | "planned" | "skipped";
  summary: string;
  legs: string[];
  totalUsd: number;
  txid?: string;
};

type PortfolioState = {
  running: boolean;
  /** Priority ladder — Alcor token ids, rank order (index 0 = top priority). */
  ladder: string[];
  settings: RebalanceSettings;
  lastRunAt: number;
  cycles: number;
  sweptUsd: number;
  movedUsd: number;
  log: PortfolioLogEntry[];
  lastPlanNote: string;

  start: () => void;
  stop: () => void;
  setLadder: (ladder: string[]) => void;
  moveLadder: (index: number, dir: -1 | 1) => void;
  addToLadder: (alcorId: string) => void;
  removeFromLadder: (alcorId: string) => void;
  setSettings: (p: Partial<RebalanceSettings>) => void;
  markRun: () => void;
  pushLog: (e: Omit<PortfolioLogEntry, "id" | "t">) => void;
  addTotals: (sweptUsd: number, movedUsd: number) => void;
  setLastPlanNote: (s: string) => void;
};

export const usePortfolio = create<PortfolioState>()(
  persist(
    (set, get) => ({
      running: false,
      ladder: [...DEFAULT_LADDER],
      settings: { ...DEFAULT_REBALANCE },
      lastRunAt: 0,
      cycles: 0,
      sweptUsd: 0,
      movedUsd: 0,
      log: [],
      lastPlanNote: "Rebalancer is stopped",

      start: () => set({ running: true, lastPlanNote: "Rebalancer running" }),
      stop: () => set({ running: false, lastPlanNote: "Rebalancer stopped" }),
      setLadder: (ladder) => set({ ladder }),
      moveLadder: (index, dir) =>
        set((s) => {
          const ladder = [...s.ladder];
          const j = index + dir;
          if (j < 0 || j >= ladder.length) return {};
          const [item] = ladder.splice(index, 1);
          ladder.splice(j, 0, item!);
          return { ladder };
        }),
      addToLadder: (alcorId) =>
        set((s) =>
          s.ladder.includes(alcorId) || s.ladder.length >= 5
            ? {}
            : { ladder: [...s.ladder, alcorId] },
        ),
      removeFromLadder: (alcorId) =>
        set((s) =>
          s.ladder.length <= 1
            ? {}
            : { ladder: s.ladder.filter((id) => id !== alcorId) },
        ),
      setSettings: (p) => set((s) => ({ settings: { ...s.settings, ...p } })),
      markRun: () => set((s) => ({ lastRunAt: Date.now(), cycles: s.cycles + 1 })),
      pushLog: (e) =>
        set((s) => ({
          log: [
            {
              ...e,
              id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
              t: new Date().toISOString(),
            },
            ...s.log,
          ].slice(0, 40),
        })),
      addTotals: (sweptUsd, movedUsd) =>
        set((s) => ({
          sweptUsd: s.sweptUsd + sweptUsd,
          movedUsd: s.movedUsd + movedUsd,
        })),
      setLastPlanNote: (lastPlanNote) => set({ lastPlanNote }),
    }),
    {
      name: "leef-portfolio-v1",
      version: 1,
      // Merging migrate: fields added to settings later get filled from
      // defaults instead of crashing on undefined.
      migrate: (persisted) => {
        const p = (
          persisted && typeof persisted === "object" ? persisted : {}
        ) as Partial<{
          ladder: string[];
          settings: Partial<RebalanceSettings>;
          cycles: number;
          sweptUsd: number;
          movedUsd: number;
          log: PortfolioLogEntry[];
        }>;
        return {
          ladder:
            Array.isArray(p.ladder) && p.ladder.length > 0
              ? p.ladder
              : [...DEFAULT_LADDER],
          settings: { ...DEFAULT_REBALANCE, ...(p.settings ?? {}) },
          cycles: typeof p.cycles === "number" ? p.cycles : 0,
          sweptUsd: typeof p.sweptUsd === "number" ? p.sweptUsd : 0,
          movedUsd: typeof p.movedUsd === "number" ? p.movedUsd : 0,
          log: Array.isArray(p.log) ? p.log : [],
        };
      },
      partialize: (s) => ({
        ladder: s.ladder,
        settings: s.settings,
        cycles: s.cycles,
        sweptUsd: s.sweptUsd,
        movedUsd: s.movedUsd,
        log: s.log.slice(0, 20),
      }),
    },
  ),
);

export const getPortfolioState = () => usePortfolio.getState();
