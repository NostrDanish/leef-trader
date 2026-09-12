/**
 * Candidate quotes are local CP math. Execution quotes must be venue-fresh.
 *
 *   Alcor     → swapRouter (CLMM, executable memos)
 *   Defibox   → on-chain pair row + CP + min-out memo (no public router)
 *   TacoSwap  → on-chain pair row + CP + min-out memo
 *
 * A local Defibox/Taco number is MODEL_ONLY until the pair row is re-read.
 * Stale or missing venue quotes are excluded from live execution.
 */
import { quoteConstantProduct } from "./amm";
import { defiboxMemo, refreshVenuePair, tacoMemo } from "./venue-adapters";
import { nativePoolId, venueOfPoolId, type VenueId } from "./venues";
import type { LeefSnapshot, QuoteLeg, SwapRoute } from "./types";
import { fetchAlcorRoute, parseAssetAmount, type AlcorRouteQuote } from "@/lib/wallet/alcor-route";
import { TradeError } from "@/lib/wallet/trade-error";
import { metaOf } from "@/lib/wallet/tokens";

export type QuoteTrust = "executable" | "model_only" | "stale";

export type VerifiedLeg = {
  venue: VenueId;
  trust: QuoteTrust;
  amountIn: number;
  amountOut: number;
  minOut: number;
  memo?: string;
  alcor?: AlcorRouteQuote;
};

const QUOTE_TTL_MS = 1_200;
const quoteCache = new Map<string, { at: number; quote: AlcorRouteQuote }>();
const inflightQuotes = new Map<string, Promise<AlcorRouteQuote>>();

function alcorKey(opts: {
  tokenInId: string;
  tokenOutId: string;
  amount: number;
  slippagePct: number;
  receiver: string;
  maxHops: number;
}): string {
  return `${opts.tokenInId}>${opts.tokenOutId}:${opts.amount.toFixed(8)}:${opts.slippagePct}:${opts.receiver}:${opts.maxHops}`;
}

export async function fetchAlcorRouteCached(opts: {
  tokenInId: string;
  tokenOutId: string;
  amount: number;
  slippagePct: number;
  receiver: string;
  maxHops?: number;
}): Promise<AlcorRouteQuote> {
  const maxHops = opts.maxHops ?? 10;
  const key = alcorKey({ ...opts, maxHops });
  const hit = quoteCache.get(key);
  if (hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.quote;
  const pending = inflightQuotes.get(key);
  if (pending) return pending;
  const p = fetchAlcorRoute({ ...opts, maxHops, timeoutMs: 5_000 })
    .then((q) => {
      quoteCache.set(key, { at: Date.now(), quote: q });
      return q;
    })
    .finally(() => inflightQuotes.delete(key));
  inflightQuotes.set(key, p);
  return p;
}

function venueOfLeg(leg: QuoteLeg): VenueId {
  return leg.venue ?? venueOfPoolId(leg.poolId);
}

export function allAlcorRoute(route: SwapRoute): boolean {
  return route.legs.every((l) => venueOfLeg(l) === "alcor");
}

/**
 * Fresh executable quote for a candidate route. Throws TradeError when the
 * preferred venue cannot verify in time — caller should try the next route.
 */
export async function verifyExecutableRoute(opts: {
  route: SwapRoute;
  amountIn: number;
  slippagePct: number;
  account: string;
  snap: LeefSnapshot;
  deadlineMs: number;
}): Promise<{ expectedOut: number; trust: QuoteTrust; verified: VerifiedLeg[] }> {
  const t0 = Date.now();
  const remaining = () => opts.deadlineMs - (Date.now() - t0);
  if (remaining() < 50) throw new TradeError("QUOTE_STALE", "Execution deadline already expired");

  if (allAlcorRoute(opts.route)) {
    const tokenIn = metaOf(opts.route.tokenIn, opts.snap);
    const tokenOut = metaOf(opts.route.tokenOut, opts.snap);
    try {
      const quote = await fetchAlcorRouteCached({
        tokenInId: tokenIn.alcorId,
        tokenOutId: tokenOut.alcorId,
        amount: opts.amountIn,
        slippagePct: opts.slippagePct,
        receiver: opts.account,
        maxHops: Math.min(10, Math.max(2, opts.route.legs.length)),
      });
      const expectedOut = parseAssetAmount(quote.output);
      if (!(expectedOut > 0)) throw new TradeError("ROUTE_DISAPPEARED", "Alcor returned no output");
      return {
        expectedOut,
        trust: "executable",
        verified: [
          {
            venue: "alcor",
            trust: "executable",
            amountIn: opts.amountIn,
            amountOut: expectedOut,
            minOut: parseAssetAmount(quote.minReceived) || expectedOut * (1 - opts.slippagePct / 100),
            alcor: quote,
          },
        ],
      };
    } catch (err) {
      if (err instanceof TradeError) throw err;
      const msg = err instanceof Error ? err.message : "Alcor quote failed";
      if (/timeout|aborted/i.test(msg)) throw new TradeError("QUOTE_TIMEOUT", msg);
      throw new TradeError("VENUE_UNAVAILABLE", msg);
    }
  }

  const slip = Math.max(0, opts.slippagePct) / 100;
  const verified: VerifiedLeg[] = [];
  let out = opts.amountIn;
  for (const leg of opts.route.legs) {
    if (remaining() < 80) throw new TradeError("QUOTE_TIMEOUT", "Deadline hit mid-route verify");
    const venue = venueOfLeg(leg);
    if (venue === "alcor") {
      const tin = metaOf(leg.tokenIn, opts.snap);
      const tout = metaOf(leg.tokenOut, opts.snap);
      const quote = await fetchAlcorRouteCached({
        tokenInId: tin.alcorId,
        tokenOutId: tout.alcorId,
        amount: leg.amountIn,
        slippagePct: opts.slippagePct,
        receiver: opts.account,
        maxHops: 1,
      });
      const amountOut = parseAssetAmount(quote.output);
      verified.push({
        venue: "alcor",
        trust: "executable",
        amountIn: leg.amountIn,
        amountOut,
        minOut: parseAssetAmount(quote.minReceived) || amountOut * (1 - slip),
        alcor: quote,
      });
      out = amountOut;
      continue;
    }
    const pair = await refreshVenuePair(venue, nativePoolId(leg.poolId), opts.snap.waxUsd);
    if (!pair) {
      throw new TradeError(
        "MODEL_ONLY",
        `${venue} pair ${nativePoolId(leg.poolId)} has no fresh on-chain quote — not executable`,
      );
    }
    const tin = leg.tokenIn.toUpperCase();
    const aIsIn = pair.tokenA.symbol.toUpperCase() === tin;
    const reserveIn = aIsIn ? pair.tokenA.quantity : pair.tokenB.quantity;
    const reserveOut = aIsIn ? pair.tokenB.quantity : pair.tokenA.quantity;
    const q = quoteConstantProduct(leg.amountIn, reserveIn, reserveOut, pair.fee);
    if (!(q.amountOut > 0)) {
      throw new TradeError("LIQUIDITY_CHANGED", `${venue} pair has no output at this size`);
    }
    const drift = Math.abs(q.amountOut - leg.amountOut) / Math.max(leg.amountOut, 1e-12);
    if (drift > 0.08) {
      throw new TradeError(
        "LIQUIDITY_CHANGED",
        `${venue} reserves moved ${(drift * 100).toFixed(1)}% vs the candidate quote`,
      );
    }
    const minOut = q.amountOut * (1 - slip);
    const tout = metaOf(leg.tokenOut, opts.snap);
    verified.push({
      venue,
      trust: "executable",
      amountIn: leg.amountIn,
      amountOut: q.amountOut,
      minOut,
      memo:
        venue === "defibox"
          ? defiboxMemo(minOut, tout.decimals, pair.nativeId)
          : tacoMemo(minOut, tout.symbol, tout.contract, tout.decimals),
    });
    out = q.amountOut;
  }
  return { expectedOut: out, trust: "executable", verified };
}
