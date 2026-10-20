/**
 * AI decision producer — the Jev (TypeSafe System One) execution seam.
 *
 * PURE and testable: no I/O, no signing, no keys, no wallet imports.
 * Jev supplies typed judgments over a market summary; code keeps control:
 * this module only builds questions and parses a proposal. The bot loop
 * gates the proposal (confidence floor + freshness) and routes it through
 * the unchanged execution gauntlet when — and only when — the user granted
 * "control".
 */
import type { JevAnswers, JevQuestion } from "./jev-client";
import type { LeefSnapshot } from "./types";

export type AiAction = "hold" | "buy" | "sell" | "swap" | "rebalance" | "reduce_risk" | "cancel_all";

export interface AiProposal {
  action: AiAction;
  params: Record<string, string>;
  confidence: number;
  /** qid of the weakest judgment that produced `confidence`. */
  weakest: string;
  answers: JevAnswers;
  rationale: string;
  fetchedAt: number;
}

/**
 * Minimum weakest-judgment confidence for an AI proposal to become an
 * execution candidate in "control" mode. Below it the proposal is advisory
 * only (logged, never executed). 0.75 means every relevant judgment —
 * action choice, its arguments, and the risk nouls — is at least 3:1 sure.
 */
export const AI_EXEC_CONFIDENCE_MIN = 0.75;

/** Question ids — parseAiProposal relies on these exact keys. */
export const AI_QID = {
  action: "action",
  sizeBucket: "size_bucket",
  swapTokenIn: "swap_token_in",
  swapTokenOut: "swap_token_out",
  riskStress: "risk_stress",
  riskExecute: "risk_execute",
} as const;

const AI_ACTIONS: AiAction[] = ["hold", "buy", "sell", "swap", "rebalance", "reduce_risk", "cancel_all"];

export const SIZE_BUCKET_PCT: Record<string, number> = { quarter: 25, half: 50, full: 100 };

/** Terse market/account summary sent as Jev `state`. No secrets, no keys. */
export interface AiSnapshotSummary {
  waxUsd: number;
  leefUsd: number;
  waxPerLeef: number;
  fetchedAt: string;
  base: string;
  quote: string;
  strategy: string;
  balances: Record<string, number>;
  positionUsd: number;
  positionAmount: number;
  topPools: {
    id: number;
    pair: string;
    feePct: number;
    tvlUsd: number;
    volume24Usd: number;
    change24: number;
  }[];
  /** Closed sets for the swap per-arg questions. */
  candidatesIn: string[];
  candidatesOut: string[];
}

/** Structural bot slice for summary building — avoids a store import here. */
export interface AiBotSlice {
  quote?: string;
  base?: string;
  strategy: string;
  position: { amountLeef: number } | null;
}

/**
 * Compact, code-owned market summary for the Jev state payload. Closed sets
 * for the per-arg questions come from held balances plus the traded pair.
 */
export function aiSummaryOf(
  snap: LeefSnapshot,
  b: AiBotSlice,
  balances: Record<string, number>,
): AiSnapshotSummary {
  const quote = (b.quote || "WAX").toUpperCase();
  const base = (b.base || "LEEF").toUpperCase();
  const held = Object.entries(balances)
    .filter(([, n]) => n > 0)
    .map(([s]) => s.toUpperCase());
  return {
    waxUsd: snap.waxUsd,
    leefUsd: snap.leefUsd,
    waxPerLeef: snap.waxPerLeef,
    fetchedAt: snap.fetchedAt,
    base,
    quote,
    strategy: b.strategy,
    balances: Object.fromEntries(
      Object.entries(balances).map(([s, n]) => [s, Number(n.toPrecision(6))]),
    ),
    positionUsd: b.position ? b.position.amountLeef * (snap.leefUsd || 0) : 0,
    positionAmount: b.position?.amountLeef ?? 0,
    topPools: snap.pools.slice(0, 5).map((p) => ({
      id: p.id,
      pair: `LEEF/${p.pair.symbol}`,
      feePct: p.feePct,
      tvlUsd: p.tvlUsd,
      volume24Usd: p.volume24Usd,
      change24: p.change24,
    })),
    candidatesIn: held.length > 0 ? held : [quote],
    candidatesOut: [...new Set([base, quote, "WAX", "WAXUSDC", "USDT"])],
  };
}

/**
 * One request, speculative fan-out: the action choice plus every per-arg
 * closed-set question and the risk nouls. Code asks everything up front and
 * ignores answers it does not need (Jev questions are parallel and cheap).
 */
export function buildAiQuestions(summary: AiSnapshotSummary): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {
    [AI_QID.action]: {
      type: "choice",
      instructions:
        "You are the trading controller for a small WAX-chain market-maker. Given `state`, which single action should the engine take THIS cycle? Choose 'hold' unless a different action is clearly justified by the state.",
      criteria: {
        hold: "Do nothing this cycle.",
        buy: `Enter/add a ${summary.base} position spending ${summary.quote}.`,
        sell: `Exit part or all of the open ${summary.base} position into ${summary.quote}.`,
        swap: "Swap between two held tokens (not the configured base/quote pair).",
        rebalance: "Move value across tokens toward a balanced portfolio (advisory — executed by the rebalancer, not this loop).",
        reduce_risk: "Cut exposure: exit the open position to reduce risk.",
        cancel_all: "Cancel all resting intent and sit flat (no resting orders exist; this just holds).",
      },
    },
    [AI_QID.sizeBucket]: {
      type: "choice",
      instructions: "IF a buy, sell or reduce_risk action were taken, what fraction of the relevant size (deployable quote balance for buys, open position for sells) should it use?",
      criteria: {
        quarter: "25% — cautious clip.",
        half: "50% — moderate.",
        full: "100% — full size.",
      },
    },
    [AI_QID.swapTokenIn]: {
      type: "choice",
      instructions: "IF a swap action were taken, which token should be spent? Choose from `state.candidatesIn`.",
      criteria: Object.fromEntries(summary.candidatesIn.map((t) => [t, `Spend ${t}.`])),
    },
    [AI_QID.swapTokenOut]: {
      type: "choice",
      instructions: "IF a swap action were taken, which token should be received? Choose from `state.candidatesOut`.",
      criteria: Object.fromEntries(summary.candidatesOut.map((t) => [t, `Receive ${t}.`])),
    },
    [AI_QID.riskStress]: {
      type: "noul",
      instructions: "Is the market in `state` under acute stress RIGHT NOW (crash, cascade, or broken/illiquid books) such that new entries are dangerous?",
      criteria: {
        true: "Clear signs of acute stress or broken books.",
        false: "Market looks orderly for its usual liquidity.",
      },
    },
    [AI_QID.riskExecute]: {
      type: "noul",
      instructions: "Is the market data in `state` coherent and fresh enough that executing a trade on it right now is safe?",
      criteria: {
        true: "Prices, pools and balances look coherent and tradable.",
        false: "Data looks stale, contradictory, or unsafe to act on.",
      },
    },
  };
  return questions;
}

/** Noul → confidence in whichever side it picked (0.5 = pure uncertainty). */
function noulConfidence(noul: number): number {
  return Math.abs(noul - 0.5) * 2;
}

function choiceOf(
  answers: JevAnswers,
  qid: string,
): { choice: string; confidence: number } | null {
  const a = answers[qid];
  if (!a || a.type !== "choice" || typeof a.choice !== "string") return null;
  if (typeof a.confidence !== "number" || !Number.isFinite(a.confidence)) return null;
  return { choice: a.choice, confidence: Math.min(1, Math.max(0, a.confidence)) };
}

function noulOf(answers: JevAnswers, qid: string): number | null {
  const a = answers[qid];
  if (!a || a.type !== "noul" || typeof a.noul !== "number" || !Number.isFinite(a.noul)) {
    return null;
  }
  return Math.min(1, Math.max(0, a.noul));
}

/**
 * Typed answers → a proposal. confidence = the WEAKEST relevant judgment
 * (action choice, its arguments, the risk nouls). Returns null when the
 * answers are unusable: missing/malformed judgments, incoherent swap args,
 * or the risk nouls contradict the action (unsafe-to-act data, or acute
 * stress against an entry).
 */
export function parseAiProposal(answers: JevAnswers): AiProposal | null {
  if (!answers || typeof answers !== "object") return null;
  const actionAns = choiceOf(answers, AI_QID.action);
  if (!actionAns || !(AI_ACTIONS as string[]).includes(actionAns.choice)) return null;
  const action = actionAns.choice as AiAction;

  const execOk = noulOf(answers, AI_QID.riskExecute);
  const stress = noulOf(answers, AI_QID.riskStress);
  if (execOk == null || stress == null) return null;

  const judgments: { qid: string; confidence: number }[] = [
    { qid: AI_QID.action, confidence: actionAns.confidence },
    { qid: AI_QID.riskExecute, confidence: noulConfidence(execOk) },
    { qid: AI_QID.riskStress, confidence: noulConfidence(stress) },
  ];

  const params: Record<string, string> = {};
  const rationale: string[] = [`action=${action} p=${actionAns.confidence.toFixed(2)}`];

  if (action !== "hold") {
    // Acting on incoherent data is never usable.
    if (execOk < 0.5) return null;
    const size = choiceOf(answers, AI_QID.sizeBucket);
    if (!size || !(size.choice in SIZE_BUCKET_PCT)) return null;
    params.sizePct = String(SIZE_BUCKET_PCT[size.choice]);
    judgments.push({ qid: AI_QID.sizeBucket, confidence: size.confidence });
    rationale.push(`size=${size.choice} p=${size.confidence.toFixed(2)}`);
  }
  if (action === "buy" || action === "swap") {
    // Acute stress vetoes entries; it never vetoes exits.
    if (stress > 0.5) return null;
  }
  if (action === "swap") {
    const tin = choiceOf(answers, AI_QID.swapTokenIn);
    const tout = choiceOf(answers, AI_QID.swapTokenOut);
    if (!tin || !tout || tin.choice === tout.choice) return null;
    params.tokenIn = tin.choice;
    params.tokenOut = tout.choice;
    judgments.push(
      { qid: AI_QID.swapTokenIn, confidence: tin.confidence },
      { qid: AI_QID.swapTokenOut, confidence: tout.confidence },
    );
    rationale.push(`${tin.choice}→${tout.choice}`);
  }
  rationale.push(`exec_ok=${execOk.toFixed(2)}`, `stress=${stress.toFixed(2)}`);

  let weakest = judgments[0]!;
  for (const j of judgments) if (j.confidence < weakest.confidence) weakest = j;

  return {
    action,
    params,
    confidence: weakest.confidence,
    weakest: weakest.qid,
    answers,
    rationale: rationale.join(" · "),
    fetchedAt: Date.now(),
  };
}
