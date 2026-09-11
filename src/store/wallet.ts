import { create } from "zustand";
import { persist } from "zustand/middleware";
import { forgetSecret, hasSecret } from "@/lib/wallet/secret";
import { hasWalletSession, logoutWallet, type WalletKind } from "@/lib/wallet/session";

const PAPER_BALANCES: Record<string, number> = {
  WAX: 250,
  LEEF: 8_000_000,
  USDT: 18,
  WAXUSDC: 12,
  // Dust tokens so the rebalancer has something to sweep in paper mode.
  TLM: 1200,
  DUST: 42_000,
  LSW: 85,
};

type WalletState = {
  mode: "paper" | "live";
  account: string;
  /** On-chain permission the session key authorizes (usually "active"). */
  permission: string;
  /** How the live session signs: in-tab key, or an external wallet. */
  authType: "key" | WalletKind | null;
  publicKey: string | null;
  liveAccountHint: string | null;
  paperBalances: Record<string, number>;
  liveBalances: Record<string, number>;
  cpuPct: number | null;
  netPct: number | null;
  ramPct: number | null;
  importOpen: boolean;
  setImportOpen: (v: boolean) => void;
  setAccount: (name: string) => void;
  setLiveSession: (p: { account: string; publicKey: string; permission?: string }) => void;
  setWalletSession: (p: { account: string; permission: string; kind: WalletKind }) => void;
  setLiveBalances: (
    bal: Record<string, number>,
    res?: { cpuPct: number | null; netPct: number | null; ramPct?: number | null },
  ) => void;
  resetPaper: () => void;
  applyPaperFill: (tokenIn: string, amountIn: number, tokenOut: string, amountOut: number) => void;
  forgetLive: () => void;
  balances: () => Record<string, number>;
  hasKey: () => boolean;
  /** Live and able to sign — via session key or an external wallet. */
  canSign: () => boolean;
};

export const useWallet = create<WalletState>()(
  persist(
    (set, get) => ({
      mode: "paper",
      account: "paper.leef",
      permission: "active",
      authType: null,
      publicKey: null,
      liveAccountHint: null,
      paperBalances: { ...PAPER_BALANCES },
      liveBalances: {},
      cpuPct: null,
      netPct: null,
      ramPct: null,
      importOpen: false,
      setImportOpen: (importOpen) => set({ importOpen }),
      setAccount: (account) => set({ account: account.trim().toLowerCase() }),
      setLiveSession: ({ account, publicKey, permission }) =>
        set({
          mode: "live",
          account,
          permission: permission ?? "active",
          authType: "key",
          publicKey,
          liveAccountHint: account,
        }),
      setWalletSession: ({ account, permission, kind }) =>
        set({
          mode: "live",
          account,
          permission,
          authType: kind,
          publicKey: null,
          liveAccountHint: account,
        }),
      setLiveBalances: (liveBalances, res) =>
        set({
          liveBalances,
          cpuPct: res?.cpuPct ?? get().cpuPct,
          netPct: res?.netPct ?? get().netPct,
          ramPct: res?.ramPct ?? get().ramPct,
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
        if (hasWalletSession()) void logoutWallet();
        set({
          mode: "paper",
          account: "paper.leef",
          permission: "active",
          authType: null,
          publicKey: null,
          liveBalances: {},
          cpuPct: null,
          netPct: null,
          ramPct: null,
        });
      },
      balances: () => {
        const s = get();
        return s.mode === "live" ? s.liveBalances : s.paperBalances;
      },
      hasKey: () => get().mode === "live" && hasSecret(),
      canSign: () => {
        const s = get();
        if (s.mode !== "live") return false;
        if (s.authType === "anchor" || s.authType === "wcw") return hasWalletSession();
        return hasSecret();
      },
    }),
    {
      name: "leef-wallet-v2",
      // Versioned: a schema bump discards stale persisted state instead of
      // shallow-merging it over the new shape (which can crash selectors).
      version: 1,
      migrate: (persisted) => {
        const p = (
          persisted && typeof persisted === "object" ? persisted : {}
        ) as Partial<{
          paperBalances: Record<string, number>;
          liveAccountHint: string | null;
          authType: "key" | WalletKind | null;
        }>;
        return {
          paperBalances:
            p.paperBalances && typeof p.paperBalances === "object"
              ? p.paperBalances
              : { ...PAPER_BALANCES },
          liveAccountHint: p.liveAccountHint ?? null,
          authType: p.authType ?? null,
        };
      },
      partialize: (s) => ({
        paperBalances: s.paperBalances,
        liveAccountHint: s.liveAccountHint,
        authType: s.authType,
      }),
    },
  ),
);
