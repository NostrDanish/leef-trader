import { create } from "zustand";
import { persist } from "zustand/middleware";
import { forgetSecret, hasSecret } from "@/lib/wallet/secret";

export type FillEvent = {
  id: string;
  t: string;
  mode: "paper" | "live";
  status: "filled" | "failed" | "skipped";
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  amountOut: number;
  routeLabel: string;
  poolIds: number[];
  reason: string;
  txid?: string;
  edgePct: number;
};

export type AutoswapSettings = {
  enabled: boolean;
  armed: boolean;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minEdgePct: number;
  maxImpactPct: number;
  maxEdgePct: number;
  cooldownSec: number;
  maxClipsHour: number;
  slippage: number;
};

const PAPER_BALANCES: Record<string, number> = {
  WAX: 250,
  LEEF: 8_000_000,
  USDT: 18,
  WAXUSDC: 12,
};

const DEFAULT_AUTO: AutoswapSettings = {
  enabled: false,
  armed: false,
  tokenIn: "WAX",
  tokenOut: "LEEF",
  amountIn: "10",
  minEdgePct: 0.35,
  maxImpactPct: 3,
  maxEdgePct: 80,
  cooldownSec: 60,
  maxClipsHour: 8,
  slippage: 0.5,
};

type WalletState = {
  mode: "paper" | "live";
  account: string;
  publicKey: string | null;
  liveAccountHint: string | null;
  paperBalances: Record<string, number>;
  liveBalances: Record<string, number>;
  cpuPct: number | null;
  netPct: number | null;
  auto: AutoswapSettings;
  log: FillEvent[];
  cooldownUntil: number;
  hourWindowStart: number;
  clipsThisHour: number;
  lastVerdict: string;
  importOpen: boolean;
  setImportOpen: (v: boolean) => void;
  setAuto: (p: Partial<AutoswapSettings>) => void;
  setAccount: (name: string) => void;
  setLiveSession: (p: { account: string; publicKey: string }) => void;
  setLiveBalances: (
    bal: Record<string, number>,
    res?: { cpuPct: number | null; netPct: number | null },
  ) => void;
  resetPaper: () => void;
  applyPaperFill: (tokenIn: string, amountIn: number, tokenOut: string, amountOut: number) => void;
  forgetLive: () => void;
  pushLog: (e: Omit<FillEvent, "id" | "t">) => void;
  markClip: (cooldownSec: number) => void;
  setLastVerdict: (s: string) => void;
  balances: () => Record<string, number>;
  hasKey: () => boolean;
};

export const useWallet = create<WalletState>()(
  persist(
    (set, get) => ({
      mode: "paper",
      account: "paper.leef",
      publicKey: null,
      liveAccountHint: null,
      paperBalances: { ...PAPER_BALANCES },
      liveBalances: {},
      cpuPct: null,
      netPct: null,
      auto: { ...DEFAULT_AUTO },
      log: [],
      cooldownUntil: 0,
      hourWindowStart: Date.now(),
      clipsThisHour: 0,
      lastVerdict: "Autoswap is off",
      importOpen: false,
      setImportOpen: (importOpen) => set({ importOpen }),
      setAuto: (p) =>
        set((s) => {
          const auto = { ...s.auto, ...p };
          if (auto.armed && (s.mode !== "live" || !hasSecret())) auto.armed = false;
          return { auto };
        }),
      setAccount: (account) => set({ account: account.trim().toLowerCase() }),
      setLiveSession: ({ account, publicKey }) =>
        set({
          mode: "live",
          account,
          publicKey,
          liveAccountHint: account,
          auto: { ...get().auto, armed: false },
        }),
      setLiveBalances: (liveBalances, res) =>
        set({
          liveBalances,
          cpuPct: res?.cpuPct ?? get().cpuPct,
          netPct: res?.netPct ?? get().netPct,
        }),
      resetPaper: () => set({ paperBalances: { ...PAPER_BALANCES } }),
      applyPaperFill: (tokenIn, amountIn, tokenOut, amountOut) =>
        set((s) => {
          const b = { ...s.paperBalances };
          const tin = tokenIn.toUpperCase();
          const tout = tokenOut.toUpperCase();
          b[tin] = Math.max(0, (b[tin] ?? 0) - amountIn);
          b[tout] = (b[tout] ?? 0) + amountOut;
          return { paperBalances: b };
        }),
      forgetLive: () => {
        forgetSecret();
        set({
          mode: "paper",
          account: "paper.leef",
          publicKey: null,
          liveBalances: {},
          cpuPct: null,
          netPct: null,
          auto: { ...get().auto, armed: false },
        });
      },
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
      markClip: (cooldownSec) => {
        const now = Date.now();
        const s = get();
        const hourStart =
          now - s.hourWindowStart > 3_600_000 ? now : s.hourWindowStart;
        const clips = hourStart === now ? 1 : s.clipsThisHour + 1;
        set({
          hourWindowStart: hourStart,
          clipsThisHour: clips,
          cooldownUntil: now + Math.max(15, cooldownSec) * 1000,
        });
      },
      setLastVerdict: (lastVerdict) => set({ lastVerdict }),
      balances: () => {
        const s = get();
        return s.mode === "live" ? s.liveBalances : s.paperBalances;
      },
      hasKey: () => get().mode === "live" && hasSecret(),
    }),
    {
      name: "leef-wallet-v1",
      partialize: (s) => ({
        paperBalances: s.paperBalances,
        auto: { ...s.auto, enabled: false, armed: false },
        log: s.log.slice(0, 20),
        liveAccountHint: s.liveAccountHint,
      }),
    },
  ),
);
