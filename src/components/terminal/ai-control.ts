import { useSyncExternalStore } from "react";
import { useTerminal } from "@/store/terminal";

/**
 * AI execution-authority hook over the terminal store contract:
 *   aiControl: "off" | "suggest" | "control"  (persisted, default "off")
 *   setAiControl(mode, confirmed?) -> boolean
 *     ("control" is REFUSED — returns false — unless confirmed === true,
 *      i.e. the UI risk dialog; leaving "control" never needs it)
 *
 * The store implements the contract; the structural read plus a session-only
 * local fallback keeps the AI desk functional if the hook is ever mounted
 * against a store build that predates it.
 */

export type AiControlMode = "off" | "suggest" | "control";

interface AiControlContract {
  aiControl?: AiControlMode;
  setAiControl?: (mode: AiControlMode, confirmed?: boolean) => boolean;
}

// --- local fallback (only exercised while the store lacks the contract) ---
let fallbackMode: AiControlMode = "off";
const fallbackListeners = new Set<() => void>();
function fallbackSubscribe(cb: () => void) {
  fallbackListeners.add(cb);
  return () => fallbackListeners.delete(cb);
}
function setFallbackMode(m: AiControlMode) {
  fallbackMode = m;
  for (const l of fallbackListeners) l();
}

export function useAiControl(): {
  mode: AiControlMode;
  /** True when CORE's persisted store contract is live (vs local fallback). */
  persisted: boolean;
  /** Returns whether the mode was applied — false = store refused it. */
  setMode: (mode: AiControlMode, confirmed?: boolean) => boolean;
} {
  const storeMode = useTerminal((s) => (s as unknown as AiControlContract).aiControl);
  const storeSet = useTerminal((s) => (s as unknown as AiControlContract).setAiControl);
  const local = useSyncExternalStore(fallbackSubscribe, () => fallbackMode, () => fallbackMode);

  const persisted = typeof storeSet === "function" && storeMode != null;
  return {
    mode: persisted ? storeMode : local,
    persisted,
    setMode: (m, confirmed) => {
      if (!persisted) {
        setFallbackMode(m);
        return true;
      }
      // Pass the risk-confirm through and surface the store's verdict.
      return storeSet(m, confirmed);
    },
  };
}
