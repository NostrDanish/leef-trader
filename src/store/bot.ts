import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_GOALS,
  DEFAULT_RISK,
  type BotGoals,
  type BotRisk,
  type BotStrategy,
  type Position,
  type PricePoint,
} from "@/lib/leef/bot-engine";

export type BotDecisionKind = "buy" | "sell" | "arb" | "hold" | "skip" | "stop" | "error";

export type BotDecisionLog = {
  id: string;
  t: string;
  kind: BotDecisionKind;
  mode: "paper" | "live";
  reason: string;
  priceUsd: number;
  txid?: string;
  pnlUsd?: number;
};

export type BotStats = {
  trades: number;
  wins: number;
  realizedUsd: number;
  startedAt: number;
  startEquityUsd: number;
  equity: { t: number; usd: number }[];
};

const MAX_SERIES = 240; // 2h of 30s prints
const MAX_LOG = 60;

type BotState = {
  running: boolean;
  strategy: BotStrategy;
  goals: BotGoals;
  risk: BotRisk;
  position: Position | null;
  gridAnchor: number | null;
  stats: BotStats;
  series: PricePoint[];
  decisions: BotDecisionLog[];
  cooldownUntil: number;
  hourWindowStart: number;
  tradesThisHour: number;
  lastReason: string;

  start: (equityUsd: number) => void;
  stop: (reason?: string) => void;
  setStrategy: (s: BotStrategy) => void;
  setGoals: (p: Partial<BotGoals>) => void;
  setRisk: (p: Partial<BotRisk>) => void;
  pushSeries: (p: PricePoint) => void;
  pushDecision: (d: Omit<BotDecisionLog, "id" | "t">) => void;
  markTrade: (cooldownSec: number) => void;
  setPosition: (p: Position | null) => void;
  setGridAnchor: (usd: number | null) => void;
  bumpPositionHigh: (usd: number) => void;
  recordResult: (pnlUsd: number, equityUsd: number) => void;
  resetSession: (equityUsd: number) => void;
  setLastReason: (s: string) => void;
};

const freshStats = (equityUsd: number): BotStats => ({
  trades: 0,
  wins: 0,
  realizedUsd: 0,
  startedAt: Date.now(),
  startEquityUsd: equityUsd,
  equity: [{ t: Date.now(), usd: equityUsd }],
});

export const useBot = create<BotState>()(
  persist(
    (set, get) => ({
      running: false,
      strategy: "signal",
      goals: { ...DEFAULT_GOALS },
      risk: { ...DEFAULT_RISK },
      position: null,
      gridAnchor: null,
      stats: freshStats(0),
      series: [],
      decisions: [],
      cooldownUntil: 0,
      hourWindowStart: Date.now(),
      tradesThisHour: 0,
      lastReason: "Bot is stopped",

      start: (equityUsd) =>
        set((s) => ({
          running: true,
          stats:
            s.stats.trades === 0 && s.stats.realizedUsd === 0
              ? freshStats(equityUsd)
              : s.stats,
          lastReason: "Bot running — scanning each 30s book pull",
        })),
      stop: (reason) =>
        set({ running: false, lastReason: reason ?? "Bot stopped" }),
      setStrategy: (strategy) =>
        set({ strategy, gridAnchor: null, lastReason: `Strategy: ${strategy}` }),
      setGoals: (p) => set((s) => ({ goals: { ...s.goals, ...p } })),
      setRisk: (p) => set((s) => ({ risk: { ...s.risk, ...p } })),
      pushSeries: (p) =>
        set((s) => ({
          series: [...s.series, p].slice(-MAX_SERIES),
        })),
      pushDecision: (d) =>
        set((s) => ({
          decisions: [
            {
              ...d,
              id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
              t: new Date().toISOString(),
            },
            ...s.decisions,
          ].slice(0, MAX_LOG),
        })),
      markTrade: (cooldownSec) => {
        const now = Date.now();
        const s = get();
        const hourStart = now - s.hourWindowStart > 3_600_000 ? now : s.hourWindowStart;
        const trades = hourStart === now ? 1 : s.tradesThisHour + 1;
        set({
          hourWindowStart: hourStart,
          tradesThisHour: trades,
          cooldownUntil: now + Math.max(15, cooldownSec) * 1000,
          stats: { ...s.stats, trades: s.stats.trades + 1 },
        });
      },
      setPosition: (position) => set({ position }),
      setGridAnchor: (gridAnchor) => set({ gridAnchor }),
      bumpPositionHigh: (usd) =>
        set((s) =>
          s.position && usd > s.position.highUsd
            ? { position: { ...s.position, highUsd: usd } }
            : {},
        ),
      recordResult: (pnlUsd, equityUsd) =>
        set((s) => ({
          stats: {
            ...s.stats,
            realizedUsd: s.stats.realizedUsd + pnlUsd,
            wins: s.stats.wins + (pnlUsd > 0 ? 1 : 0),
            equity: [...s.stats.equity, { t: Date.now(), usd: equityUsd }].slice(-120),
          },
        })),
      resetSession: (equityUsd) =>
        set({
          stats: freshStats(equityUsd),
          decisions: [],
          position: null,
          gridAnchor: null,
          tradesThisHour: 0,
          hourWindowStart: Date.now(),
          cooldownUntil: 0,
          lastReason: "Session reset",
        }),
      setLastReason: (lastReason) => set({ lastReason }),
    }),
    {
      name: "leef-bot-v1",
      // Versioned: a schema bump discards stale persisted state instead of
      // shallow-merging it over the new shape (which can crash selectors).
      version: 1,
      partialize: (s) => ({
        // Never persist `running` — a reload always stops the bot (the live
        // key is in-memory only, so it could not sign anyway).
        strategy: s.strategy,
        goals: s.goals,
        risk: s.risk,
        position: s.position,
        gridAnchor: s.gridAnchor,
        stats: s.stats,
        series: s.series.slice(-MAX_SERIES),
        decisions: s.decisions.slice(0, 30),
      }),
    },
  ),
);
