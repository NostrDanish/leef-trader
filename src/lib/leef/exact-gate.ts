/**
 * Universal exact-quote economic gate.
 *
 * The graph's constant-product math is a DISCOVERY tool — Alcor is a CLMM
 * and the local quote is never the execution truth. Before any strategy's
 * trade reaches a signer, this gate re-runs the trade's own thesis on the
 * fresh executable venue output for the exact size:
 *
 *   graph discovery → candidate → EXACT VENUE QUOTE → this gate → sign
 *
 * Every trade answers one question: at this exact size, on this exact venue,
 * right now, does this trade still make economic sense? If no → HOLD.
 *
 * The four quantities are modeled separately (they are not the same thing):
 *   expectedOut  — what the venue expects to pay (economics)
 *   guaranteedOut — min-out summed over legs (worst case the chain allows)
 *   execIn       — what actually goes in
 *   protected    — the on-chain floor enforced by the memo
 */
import { estimateRoundTripCosts, executionCostPct, usdPriceOf } from "./cost-model";
import type { LeefSnapshot, SwapRoute } from "./types";

export type ExactGateOpts = {
  snap: LeefSnapshot;
  route: SwapRoute;
  amountIn: number;
  /** Venue-quoted expected output for this exact size. */
  expectedOut: number;
  /** Sum of leg min-outs (chain-guaranteed worst case), when known. */
  guaranteedOut?: number;
};

/** Exact one-shot economics of a verified venue quote. */
export function exactOneShot(opts: ExactGateOpts): {
  exactNetUsd: number;
  exactNetPct: number;
  exactExecCostPct: number;
} {
  const pxIn = usdPriceOf(opts.route.tokenIn, opts.snap);
  const pxOut = usdPriceOf(opts.route.tokenOut, opts.snap);
  if (!(pxIn > 0) || !(pxOut > 0) || !(opts.amountIn > 0)) {
    return { exactNetUsd: 0, exactNetPct: -100, exactExecCostPct: 100 };
  }
  const usdIn = opts.amountIn * pxIn;
  const usdOut = opts.expectedOut * pxOut;
  const exactRoute = { ...opts.route, amountOut: opts.expectedOut };
  return {
    exactNetUsd: usdOut - usdIn,
    exactNetPct: usdIn > 0 ? ((usdOut - usdIn) / usdIn) * 100 : -100,
    exactExecCostPct: executionCostPct(exactRoute, opts.snap),
  };
}

/**
 * Position-entry gate: does the exact quote still leave the strategy's
 * expected gross move ahead of ALL round-trip costs? The entry execution
 * cost is now measured exactly; exit cost stays modeled (the exit is a
 * future trade on a future book).
 */
export function exactEntryVerdict(opts: ExactGateOpts & {
  exitRoute: SwapRoute | null;
  expectedGrossPct: number;
  minNetEdgePct: number;
  volPerSec: number;
}): { pass: boolean; netEdgePct: number; reason: string } {
  const exactRoute = { ...opts.route, amountOut: opts.expectedOut };
  const costs = estimateRoundTripCosts({
    route: exactRoute,
    exitRoute: opts.exitRoute,
    snap: opts.snap,
    volPerSec: opts.volPerSec,
  });
  const pxIn = usdPriceOf(opts.route.tokenIn, opts.snap);
  const notionalUsd = opts.amountIn * pxIn;
  if (!(notionalUsd > 0)) return { pass: false, netEdgePct: -100, reason: "exact gate: no notional" };
  const netEdgePct =
    opts.expectedGrossPct - costs.totalPct - (costs.fixedUsd / notionalUsd) * 100;
  const pass = netEdgePct + 1e-12 >= opts.minNetEdgePct;
  return {
    pass,
    netEdgePct,
    reason: pass
      ? `exact net edge ${netEdgePct.toFixed(2)}% ≥ ${opts.minNetEdgePct}% (exec ${costs.execInPct.toFixed(2)}% exact)`
      : `exact net edge ${netEdgePct.toFixed(2)}% < required ${opts.minNetEdgePct}% — venue quote killed the thesis`,
  };
}

/**
 * One-shot swap gate (path/cycle/tape): the exact venue output must clear
 * the decision's own net floor. Floors are per-decision — a profit path
 * floors at ≥0, a volume clip floors at its loss budget.
 */
export function exactSwapVerdict(opts: ExactGateOpts & {
  minNetPct: number;
  /**
   * Explicit tolerance the GUARANTEED (min-out) side may dip below the floor,
   * percent. Default 0 — the floor is a floor. (Was a hidden 0.05.)
   */
  floorTolerancePct?: number;
}): { pass: boolean; exactNetPct: number; reason: string } {
  const { exactNetPct, exactExecCostPct } = exactOneShot(opts);
  // Worst case matters too: if the guaranteed output breaches the floor,
  // the optimistic quote is not enough.
  let guaranteedPct = exactNetPct;
  if (opts.guaranteedOut != null) {
    const pxIn = usdPriceOf(opts.route.tokenIn, opts.snap);
    const pxOut = usdPriceOf(opts.route.tokenOut, opts.snap);
    if (pxIn > 0 && pxOut > 0 && opts.amountIn > 0) {
      const gUsd = opts.guaranteedOut * pxOut;
      const inUsd = opts.amountIn * pxIn;
      guaranteedPct = inUsd > 0 ? ((gUsd - inUsd) / inUsd) * 100 : -100;
    }
  }
  const tol = Math.max(0, opts.floorTolerancePct ?? 0);
  const pass =
    exactNetPct + 1e-9 >= opts.minNetPct && guaranteedPct + 1e-9 >= opts.minNetPct - tol;
  return {
    pass,
    exactNetPct,
    reason: pass
      ? `exact net ${exactNetPct.toFixed(2)}% ≥ ${opts.minNetPct}% (exec cost ${exactExecCostPct.toFixed(2)}%)`
      : `exact net ${exactNetPct.toFixed(2)}% / guaranteed ${guaranteedPct.toFixed(2)}% < floor ${opts.minNetPct}%${tol > 0 ? ` (+${tol}% tol)` : ""}`,
  };
}
