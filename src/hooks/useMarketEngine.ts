import { useSyncExternalStore } from "react";
import { marketEngine, type EngineState } from "@/lib/market/market-engine";

/**
 * React window onto the persistent MarketEngine. The engine owns every
 * market/bot/balance loop; components subscribe and re-render on engine
 * version bumps — mounting/unmounting UI never stops the trading engine.
 */
export function useMarketEngine(): EngineState {
  return useSyncExternalStore(marketEngine.subscribe, marketEngine.getState, marketEngine.getState);
}
