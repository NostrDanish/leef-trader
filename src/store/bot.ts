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

/** Per-strategy calibration record — predicted vs realized edge. */
export type StrategyPerf = {
  trades: number;
  wins: number;
  pnlUsd: number;
  /** Sum of predicted net edges at entry, percent (÷ trades = mean prediction). */
  predEdgePctSum: number;
  /** Sum of realized net edges at exit, percent (÷ trades = mean realized). */
  realEdgePctSum: number;
  /** Sum of execution latencies (sign→reconcile), ms. */
  latencyMsSum: number;
};

export type BotStats = {
  trades: number;
  wins: number;
  realizedUsd: number;
  /** Volume maker: gross USD notional cycled through the books. */
  volumeUsd: number;
  /** Volume maker: net USD cost of echo round trips (negative = profit). */
  echoCostUsd: number;
  /** Last closed trade's P&L — feeds the adaptive cooldown (anti-tilt). */
  lastPnlUsd: number;
  /** Calibration memory per strategy id. */
  byStrategy: Record<string, StrategyPerf>;
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
  recordVolume: (volumeUsd: number, costUsd: number) => void;
  /** Calibration: record one closed trade under the strategy that opened it. */
  recordStrategyPerf: (
    strategy: string,
    r: { pnlUsd: number; predEdgePct: number | null; realEdgePct: number; latencyMs: number | null },
  ) => void;
  resetSession: (equityUsd: number) => void;
  setLastReason: (s: string) => void;
};

const freshStats = (equityUsd: number): BotStats => ({
  trades: 0,
  wins: 0,
  realizedUsd: 0,
  volumeUsd: 0,
  echoCostUsd: 0,
  lastPnlUsd: 0,
  byStrategy: {},
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
            lastPnlUsd: pnlUsd,
            equity: [...s.stats.equity, { t: Date.now(), usd: equityUsd }].slice(-120),
          },
        })),
      recordStrategyPerf: (strategy, r) =>
        set((s) => {
          const prev = s.stats.byStrategy[strategy] ?? {
            trades: 0,
            wins: 0,
            pnlUsd: 0,
            predEdgePctSum: 0,
            realEdgePctSum: 0,
            latencyMsSum: 0,
          };
          return {
            stats: {
              ...s.stats,
              byStrategy: {
                ...s.stats.byStrategy,
                [strategy]: {
                  trades: prev.trades + 1,
                  wins: prev.wins + (r.pnlUsd > 0 ? 1 : 0),
                  pnlUsd: prev.pnlUsd + r.pnlUsd,
                  predEdgePctSum: prev.predEdgePctSum + (r.predEdgePct ?? 0),
                  realEdgePctSum: prev.realEdgePctSum + r.realEdgePct,
                  latencyMsSum: prev.latencyMsSum + (r.latencyMs ?? 0),
                },
              },
            },
          };
        }),
      recordVolume: (volumeUsd, costUsd) =>
        set((s) => ({
          stats: {
            ...s.stats,
            volumeUsd: s.stats.volumeUsd + volumeUsd,
            echoCostUsd: s.stats.echoCostUsd + costUsd,
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
      // Versioned + merging migrate: fields added to the schema after a user
      // saved state (e.g. risk.minNetEdgePct, stats.byStrategy) get filled
      // from defaults instead of crashing selectors with undefined.
      version: 4,
      migrate: (persisted) => {
        const p = (
          persisted && typeof persisted === "object" ? persisted : {}
        ) as Partial<{
          strategy: BotStrategy;
          goals: Partial<BotGoals>;
          risk: Partial<BotRisk>;
          position: Position | null;
          gridAnchor: number | null;
          stats: BotStats;
          series: PricePoint[];
          decisions: BotDecisionLog[];
        }>;
        return {
          strategy: p.strategy ?? "signal",
          goals: { ...DEFAULT_GOALS, ...(p.goals ?? {}) },
          risk: { ...DEFAULT_RISK, ...(p.risk ?? {}) },
          position: p.position ?? null,
          gridAnchor: p.gridAnchor ?? null,
          // Merge stats over defaults so fields added later (volumeUsd…) exist.
          stats:
            p.stats && typeof p.stats === "object"
              ? { ...freshStats(0), ...p.stats }
              : freshStats(0),
          series: Array.isArray(p.series) ? p.series : [],
          decisions: Array.isArray(p.decisions) ? p.decisions : [],
        };
      },
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
