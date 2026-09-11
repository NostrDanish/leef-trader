import type { SwapRoute } from "@/lib/leef/types";
import { formatAsset, metaOf, type TokenMeta } from "./tokens";

/** Alcor swap.alcor transfer memo from our routed legs. */
export function memoForRoute(
  route: SwapRoute,
  receiver: string,
  slippagePct: number,
  tokenOut: TokenMeta,
): string {
  const ids = route.poolIds.join(",");
  const min = route.amountOut * (1 - Math.max(0, slippagePct) / 100);
  const minAsset = formatAsset(min, tokenOut);
  const ext = `${minAsset.split(" ")[0]} ${tokenOut.symbol}@${tokenOut.contract}`;
  return `swapexactin#${ids}#${receiver}#${ext}#0`;
}

export function tokenInMeta(route: SwapRoute, snap?: Parameters<typeof metaOf>[1]): TokenMeta {
  return metaOf(route.tokenIn, snap);
}
