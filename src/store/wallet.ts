import { create } from "zustand";
import { persist } from "zustand/middleware";
import { forgetSecret, hasSecret } from "@/lib/wallet/secret";

const PAPER_BALANCES: Record<string, number> = {
  WAX: 250,
  LEEF: 8_000_000,
  USDT: 18,
  WAXUSDC: 12,
};

type WalletState = {
  mode: "paper" | "live";
  account: string;
  /** On-chain permission the session key authorizes (usually "active"). */
  permission: string;
  publicKey: string | null;
  liveAccountHint: string | null;
  paperBalances: Record<string, number>;
  liveBalances: Record<string, number>;
  cpuPct: number | null;
  netPct: number | null;
  importOpen: boolean;
  setImportOpen: (v: boolean) => void;
  setAccount: (name: string) => void;
  setLiveSession: (p: { account: string; publicKey: string; permission?: string }) => void;
  setLiveBalances: (
    bal: Record<string, number>,
    res?: { cpuPct: number | null; netPct: number | null },
  ) => void;
  resetPaper: () => void;
  applyPaperFill: (tokenIn: string, amountIn: number, tokenOut: string, amountOut: number) => void;
  forgetLive: () => void;
  balances: () => Record<string, number>;
  hasKey: () => boolean;
};

export const useWallet = create<WalletState>()(
  persist(
    (set, get) => ({
      mode: "paper",
      account: "paper.leef",
      permission: "active",
      publicKey: null,
      liveAccountHint: null,
      paperBalances: { ...PAPER_BALANCES },
      liveBalances: {},
      cpuPct: null,
      netPct: null,
      importOpen: false,
      setImportOpen: (importOpen) => set({ importOpen }),
      setAccount: (account) => set({ account: account.trim().toLowerCase() }),
      setLiveSession: ({ account, publicKey, permission }) =>
        set({
          mode: "live",
          account,
          permission: permission ?? "active",
          publicKey,
          liveAccountHint: account,
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
          permission: "active",
          publicKey: null,
          liveBalances: {},
          cpuPct: null,
          netPct: null,
        });
      },
      balances: () => {
        const s = get();
        return s.mode === "live" ? s.liveBalances : s.paperBalances;
      },
      hasKey: () => get().mode === "live" && hasSecret(),
    }),
    {
      name: "leef-wallet-v2",
      // Versioned: a schema bump discards stale persisted state instead of
      // shallow-merging it over the new shape (which can crash selectors).
      version: 1,
      partialize: (s) => ({
        paperBalances: s.paperBalances,
        liveAccountHint: s.liveAccountHint,
      }),
    },
  ),
);
