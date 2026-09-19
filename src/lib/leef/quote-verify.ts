/**
 * Candidate quotes are local CP math. Execution quotes must be venue-fresh.
 *
 *   Alcor     → swapRouter (CLMM, executable memos)
 *   Defibox   → on-chain pair row + CP + min-out memo (no public router)
 *   TacoSwap  → on-chain pair row + CP + min-out memo
 *
 * A local Defibox/Taco number is MODEL_ONLY until the pair row is re-read.
 * Stale or missing venue quotes are excluded from live execution.
 *
 * Venue cache caveat (verified against alcor-ui server, CACHE_TTL = 5000):
 * the swapRouter caches each trade for 5 s server-side, so a "fresh" re-quote
 * inside that window usually returns the IDENTICAL cached trade — re-quoting
 * more often buys nothing. The on-chain minOut memo, not the re-quote, is
 * the real freshness guarantee (and it is enforced on every executable leg).
 */
import { quoteConstantProduct } from "./amm";
import { defiboxMemo, refreshVenuePair, tacoMemo } from "./venue-adapters";
import { nativePoolId, venueOfPoolId, type VenueId } from "./venues";
import type { LeefSnapshot, QuoteLeg, SwapRoute } from "./types";
import { fetchAlcorRoute, parseAssetAmount, type AlcorRouteQuote } from "@/lib/wallet/alcor-route";
import { TradeError } from "@/lib/wallet/trade-error";
import { metaOf } from "@/lib/wallet/tokens";

export type QuoteTrust = "executable" | "model_only" | "stale";

/**
 * How close the quote is to the venue's own execution math:
 *   exact       — Alcor swapRouter: the venue's CLMM engine computed this.
 *   fresh_model — Defibox/Taco: fresh on-chain reserves + the venue's CP
 *                 formula. The contract's own math, but reserve drift between
 *                 read and execution is unpriced. Min-out memo is the hard guard.
 */
export type QuoteExactness = "exact" | "fresh_model";

export type VerifiedLeg = {
  venue: VenueId;
  trust: QuoteTrust;
  exactness: QuoteExactness;
  amountIn: number;
  amountOut: number;
  minOut: number;
  /**
   * The venue's own CLMM-exact price impact (percent), parsed from the Alcor
   * router quote. Present only on venue-exact legs — the sharpest model↔venue
   * drift evidence there is (journal: venueImpactPct).
   */
  venueImpactPct?: number;
  memo?: string;
  alcor?: AlcorRouteQuote;
};

/** Alcor returns priceImpact as a percent string ("0.12"); keep it finite. */
function parseVenueImpactPct(raw: string | undefined): number | undefined {
  const n = raw == null ? NaN : Number.parseFloat(raw);
  return Number.isFinite(n) ? Math.abs(n) : undefined;
}

/**
 * Route-level venue impact from per-leg venue-exact impacts (compounded like
 * combineImpact), or undefined when no leg reported one (fresh-model venues).
 */
export function routeVenueImpactPct(
  legs: Pick<VerifiedLeg, "venueImpactPct">[],
): number | undefined {
  let keep = 1;
  let seen = false;
  for (const l of legs) {
    if (l.venueImpactPct == null) continue;
    seen = true;
    keep *= 1 - l.venueImpactPct / 100;
  }
  return seen ? Math.max(0, (1 - keep) * 100) : undefined;
}

/**
 * Combine per-leg min-outs into the route-level guaranteed worst case.
 * Split legs are independent slices → sum. Sequential hops chain on each
 * other's guaranteed output → the final leg's min-out is the guarantee.
 * Exported pure for regression tests (the Strategy V2 gate consumes this,
 * never a hand-rolled re-derivation).
 */
export function combineGuaranteedOut(
  legs: Pick<VerifiedLeg, "minOut">[],
  split: boolean,
): number {
  if (legs.length === 0) return 0;
  if (split) return legs.reduce((s, l) => s + l.minOut, 0);
  return legs[legs.length - 1]!.minOut;
}

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
  decimalsIn?: number;
}): string {
  return `${opts.tokenInId}>${opts.tokenOutId}:${opts.amount.toFixed(8)}:${opts.slippagePct}:${opts.receiver}:${opts.maxHops}:${opts.decimalsIn ?? "guess"}`;
}

export async function fetchAlcorRouteCached(opts: {
  tokenInId: string;
  tokenOutId: string;
  amount: number;
  slippagePct: number;
  receiver: string;
  maxHops?: number;
  /** Authoritative input-token precision — never guess from the id string. */
  decimalsIn?: number;
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

/** Fresh input for a route leg: split slices are independent; hops chain. */
export function verifiedLegInput(
  route: Pick<SwapRoute, "kind" | "legs">,
  originalAmountIn: number,
  verified: VerifiedLeg[],
  legIndex: number,
): number {
  const leg = route.legs[legIndex];
  if (!leg) return 0;
  if (route.kind === "split") return leg.amountIn;
  // Sequential atomic action N may only spend what action N-1 GUARANTEES.
  // Chaining expected output would overdraw whenever the prior fill lands
  // inside its valid slippage band but below the optimistic quote.
  return legIndex === 0 ? originalAmountIn : (verified[legIndex - 1]?.minOut ?? 0);
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
}): Promise<{
  expectedOut: number;
  /** Chain-guaranteed worst case: sum of leg min-outs (split) or the final leg's min-out (hops). */
  guaranteedOut: number;
  trust: QuoteTrust;
  /** "exact" only when EVERY leg came from the venue's own engine (Alcor router). */
  exactness: QuoteExactness;
  /** Compounded venue-reported CLMM price impact (percent), when any leg reported one. */
  venueImpactPct?: number;
  verified: VerifiedLeg[];
}> {
  const t0 = Date.now();
  const remaining = () => opts.deadlineMs - (Date.now() - t0);
  if (remaining() < 50) throw new TradeError("QUOTE_STALE", "Execution deadline already expired");

  // A cycle (LEEF→…→LEEF) can NOT use the single-call fast path: Alcor's
  // router answers 403 "Invalid input/output" when input === output (verified
  // live 2026-09-17). Cycles verify leg-by-leg like mixed-venue routes, with
  // each leg's guaranteed min-out chaining into the next leg's input.
  const isCycle =
    opts.route.tokenIn.toUpperCase() === opts.route.tokenOut.toUpperCase();
  // The venue caps maxHops at 3 server-side: only ≤3-leg routes may take the
  // single-call fast path. A >3-leg route quoted whole would let Alcor
  // re-pick a different ≤3-hop path whose executed legs diverge from the
  // evaluated ones — those verify leg-by-leg like mixed-venue routes.
  if (allAlcorRoute(opts.route) && !isCycle && opts.route.legs.length <= 3) {
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
        decimalsIn: tokenIn.decimals,
      });
      const expectedOut = parseAssetAmount(quote.output);
      if (!(expectedOut > 0)) throw new TradeError("ROUTE_DISAPPEARED", "Alcor returned no output");
      // Fail closed: a missing/unparseable minReceived means the quote has NO
      // enforceable floor. Never invent one from expectedOut — the gate, fee
      // and chained-leg sizing would run on a fabricated guarantee.
      const minOut = parseAssetAmount(quote.minReceived);
      if (!(minOut > 0)) {
        throw new TradeError(
          "QUOTE_FAILURE",
          "Alcor quote carried no min-out guarantee (minReceived missing or zero)",
        );
      }
      const venueImpactPct = parseVenueImpactPct(quote.priceImpact);
      return {
        expectedOut,
        guaranteedOut: minOut,
        trust: "executable",
        exactness: "exact",
        venueImpactPct,
        verified: [
          {
            venue: "alcor",
            trust: "executable",
            exactness: "exact",
            amountIn: opts.amountIn,
            amountOut: expectedOut,
            minOut,
            venueImpactPct,
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
  const split = opts.route.kind === "split";
  let expectedOut = 0;
  for (const leg of opts.route.legs) {
    if (remaining() < 80) throw new TradeError("QUOTE_TIMEOUT", "Deadline hit mid-route verify");
    // Split legs are independent slices. Hop legs are sequential and MUST
    // spend the previous leg's freshly verified output, not stale model input.
    const amountIn = verifiedLegInput(opts.route, opts.amountIn, verified, verified.length);
    if (!(amountIn > 0)) {
      throw new TradeError("LIQUIDITY_CHANGED", "Previous route leg produced no spendable output");
    }
    const venue = venueOfLeg(leg);
    let amountOut: number;
    if (venue === "alcor") {
      const tin = metaOf(leg.tokenIn, opts.snap);
      const tout = metaOf(leg.tokenOut, opts.snap);
      const quote = await fetchAlcorRouteCached({
        tokenInId: tin.alcorId,
        tokenOutId: tout.alcorId,
        amount: amountIn,
        slippagePct: opts.slippagePct,
        receiver: opts.account,
        maxHops: 1,
        decimalsIn: tin.decimals,
      });
      amountOut = parseAssetAmount(quote.output);
      if (!(amountOut > 0)) {
        throw new TradeError("ROUTE_DISAPPEARED", "Alcor route leg returned no output");
      }
      // Fail closed on a missing/zero minReceived (see the fast path above) —
      // the guarantee is never fabricated from the expected output.
      const legMinOut = parseAssetAmount(quote.minReceived);
      if (!(legMinOut > 0)) {
        throw new TradeError(
          "QUOTE_FAILURE",
          "Alcor route leg carried no min-out guarantee (minReceived missing or zero)",
        );
      }
      verified.push({
        venue: "alcor",
        trust: "executable",
        exactness: "exact",
        amountIn,
        amountOut,
        minOut: legMinOut,
        venueImpactPct: parseVenueImpactPct(quote.priceImpact),
        alcor: quote,
      });
    } else {
      const pair = await refreshVenuePair(venue, nativePoolId(leg.poolId), opts.snap.waxUsd);
      if (!pair) {
        throw new TradeError(
          "MODEL_ONLY",
          `${venue} pair ${nativePoolId(leg.poolId)} has no fresh on-chain quote — not executable`,
        );
      }
      const tin = metaOf(leg.tokenIn, opts.snap);
      const aMatches =
        pair.tokenA.symbol.toUpperCase() === tin.symbol && pair.tokenA.contract === tin.contract;
      const bMatches =
        pair.tokenB.symbol.toUpperCase() === tin.symbol && pair.tokenB.contract === tin.contract;
      if (!aMatches && !bMatches) {
        throw new TradeError("ROUTE_DISAPPEARED", `${venue} pool token identity changed`);
      }
      const reserveIn = aMatches ? pair.tokenA.quantity : pair.tokenB.quantity;
      const reserveOut = aMatches ? pair.tokenB.quantity : pair.tokenA.quantity;
      const q = quoteConstantProduct(amountIn, reserveIn, reserveOut, pair.fee);
      if (!(q.amountOut > 0)) {
        throw new TradeError("LIQUIDITY_CHANGED", `${venue} pair has no output at this size`);
      }
      // Compare fresh output with the modeled leg scaled to this chained input.
      const modeledOut = leg.amountIn > 0 ? leg.amountOut * (amountIn / leg.amountIn) : 0;
      const drift = Math.abs(q.amountOut - modeledOut) / Math.max(modeledOut, 1e-12);
      if (drift > 0.08) {
        throw new TradeError(
          "LIQUIDITY_CHANGED",
          `${venue} reserves moved ${(drift * 100).toFixed(1)}% vs the candidate quote`,
        );
      }
      amountOut = q.amountOut;
      const minOut = amountOut * (1 - slip);
      const tout = metaOf(leg.tokenOut, opts.snap);
      verified.push({
        venue,
        trust: "executable",
        exactness: "fresh_model",
        amountIn,
        amountOut,
        minOut,
        memo:
          venue === "defibox"
            ? defiboxMemo(minOut, tout.decimals, pair.nativeId)
            : tacoMemo(minOut, tout.symbol, tout.contract, tout.decimals),
      });
    }
    if (split) expectedOut += amountOut;
    else expectedOut = amountOut;
  }
  const guaranteedOut = combineGuaranteedOut(verified, split);
  const exactness: QuoteExactness = verified.every((v) => v.exactness === "exact")
    ? "exact"
    : "fresh_model";
  return {
    expectedOut,
    guaranteedOut,
    trust: "executable",
    exactness,
    venueImpactPct: routeVenueImpactPct(verified),
    verified,
  };
}
