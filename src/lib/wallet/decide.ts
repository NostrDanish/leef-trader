import type { SwapRoute } from "@/lib/leef/types";

export type ClipAction = "skip" | "paper" | "live";

export type ClipVerdict = {
  ok: boolean;
  action: ClipAction;
  reason: string;
  route?: SwapRoute;
  runner?: SwapRoute;
  edgePct: number;
};

export type ClipInput = {
  enabled: boolean;
  armed: boolean;
  mode: "paper" | "live";
  hasKey: boolean;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  routes: SwapRoute[];
  balances: Record<string, number>;
  /** Percent points, e.g. 0.4 = 0.4%. */
  minEdgePct: number;
  maxImpactPct: number;
  maxEdgePct: number;
  cooldownUntil: number;
  clipsThisHour: number;
  maxClipsHour: number;
  now: number;
  /** Manual clip ignores the Run switch and cooldown. */
  force?: boolean;
};

export function evaluateClip(a: ClipInput): ClipVerdict {
  if (!a.enabled && !a.force) return skip("Autoswap is off");
  if (!a.force && a.now < a.cooldownUntil) {
    const s = Math.ceil((a.cooldownUntil - a.now) / 1000);
    return skip(`Cooldown ${s}s`);
  }
  if (a.clipsThisHour >= a.maxClipsHour) return skip("Hourly clip cap reached");
  if (!(a.amountIn > 0)) return skip("Clip size is zero");

  const best = a.routes[0];
  const runner = a.routes[1];
  if (!best) return skip("No backed route for this pair");

  const impactPct = best.priceImpact * 100;
  if (impactPct > a.maxImpactPct) {
    return skip(`Impact ${impactPct.toFixed(2)}% above ${a.maxImpactPct.toFixed(1)}% cap`);
  }

  const edge =
    runner && runner.amountOut > 0 ? best.amountOut / runner.amountOut - 1 : 0;
  const edgePct = edge * 100;
  if (edgePct + 1e-9 < a.minEdgePct) {
    return skip(
      `Edge ${edgePct.toFixed(2)}% is below the ${a.minEdgePct.toFixed(2)}% floor vs the next book`,
    );
  }
  if (edgePct > a.maxEdgePct) {
    return skip(`Edge ${edgePct.toFixed(1)}% looks like a broken book — skipped`);
  }

  const have = a.balances[a.tokenIn.toUpperCase()] ?? 0;
  if (have + 1e-9 < a.amountIn) {
    return skip(`Need ${a.amountIn} ${a.tokenIn}, wallet has ${have.toFixed(4)}`);
  }

  if (a.armed && a.mode === "live" && a.hasKey) {
    return {
      ok: true,
      action: "live",
      reason: `Live clip on ${best.label}`,
      route: best,
      runner,
      edgePct,
    };
  }

  return {
    ok: true,
    action: "paper",
    reason: a.armed
      ? `Paper clip (import a key to arm live) · ${best.label}`
      : `Paper clip · ${best.label}`,
    route: best,
    runner,
    edgePct,
  };
}

function skip(reason: string): ClipVerdict {
  return { ok: false, action: "skip", reason, edgePct: 0 };
}
