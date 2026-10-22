/**
 * Bot settings the shell can read without loading the strategy engine.
 * The engine re-exports these so existing imports keep working.
 */
import {
  DEFAULT_MAX_POSITION_USD,
  DEFAULT_MIN_TRADE_USD,
  DEFAULT_OPERATIONAL_RESERVE_USD,
} from "./risk-usd";

export type BotStrategy =
  | "auto"
  | "unleashed"
  | "signal"
  | "meanrev"
  | "spread"
  | "grid"
  | "dca"
  | "volume"
  | "growth";

export type BotGoals = {
  /** Per-position take-profit, percent. */
  takeProfitPct: number;
  /** Per-position stop-loss, percent. */
  stopLossPct: number;
  /** Trailing stop: arms once profit exceeded trailingPct, sells on this much giveback. */
  trailingPct: number;
  /** Stop the bot for the session once realized P&L reaches this USD amount. */
  sessionGoalUsd: number;
  /** Stop the bot if session equity drawdown exceeds this percent. 0 = off (unsafe). */
  maxDrawdownPct: number;
  /**
   * Stop the bot once session REALIZED P&L falls to −this many USD.
   * 0 = derive it from `maxDailyLossPct` × session-start equity.
   */
  maxSessionLossUsd: number;
  /**
   * Session loss limit as a percent of session-start equity, used when
   * `maxSessionLossUsd` is 0. 0 (with maxSessionLossUsd 0) = off (unsafe).
   */
  maxDailyLossPct: number;
};

export type BotRisk = {
  /** Minimum notional per new trade, USD. Converted to quote-token units at the live mark. */
  minTradeUsd: number;
  /** Maximum marked position value, USD. Remaining capacity sizes the next clip. */
  maxPositionUsd: number;
  /** USD value kept unspent in the quote token for continued operation. */
  operationalReserveUsd: number;
  maxImpactPct: number;
  cooldownSec: number;
  maxTradesHour: number;
  slippage: number;
  /** Signal strategy: minimum blend confidence (0-1 shown as %). */
  minConfidence: number;
  /** Spread strategy: minimum atomic profit after fees/impact, percent. */
  minEdgePct: number;
  /** Grid strategy: step size, percent. */
  gridStepPct: number;
  /** Volume strategy: max acceptable round-trip loss, percent. */
  maxEchoLossPct: number;
  /**
   * Volume gate: no echo/volume trade unless the pool saw a THIRD-PARTY swap
   * within this many minutes (flow evidence the book is alive). Fail closed
   * when flow data is unavailable. Volume intents only — profit intents are
   * never flow-gated. 0 disables the gate (the echo budget still applies).
   */
  volumeFlowGateMin: number;
  /**
   * Session echo budget, USD: once `stats.echoCostUsd` reaches this cap,
   * volume intents stop for the session. 0 disables the budget.
   */
  echoBudgetUsd: number;
  /**
   * Minimum NET edge an entry must clear after ALL modeled costs (round-trip
   * execution, slippage allowance, opportunity decay, resource + failure
   * cost), percent of notional. 0.1% keeps WAX micro-edges viable while
   * refusing trades whose costs eat the thesis.
   */
  minNetEdgePct: number;
  /**
   * Maximum age of the book a decision may act on, seconds. Default 45
   * assumed a 30s pull. At runtime the loop uses max(this, syncSec + 15)
   * so a Live/10s book is never treated as stale.
   */
  maxQuoteAgeSec: number;
  /** Graph depth cap for routing (1–10). Strategies pick ≤ this, not always 10. */
  maxHops: number;
  /**
   * Liquidity-relative position cap: a position may not exceed this percent
   * of the deepest DIRECT base/quote pool's TVL. 0 = off.
   */
  maxPoolSharePct: number;
};

/**
 * Effective session loss limit in USD: the explicit USD value when set,
 * else `maxDailyLossPct` of session-start equity. 0 = no limit.
 */
export function sessionLossCapUsd(
  goals: Pick<BotGoals, "maxSessionLossUsd" | "maxDailyLossPct">,
  sessionStartEquityUsd: number,
): number {
  if (goals.maxSessionLossUsd > 0) return goals.maxSessionLossUsd;
  if (!(goals.maxDailyLossPct > 0) || !(sessionStartEquityUsd > 0)) return 0;
  return sessionStartEquityUsd * (goals.maxDailyLossPct / 100);
}

export const DEFAULT_GOALS: BotGoals = {
  takeProfitPct: 6,
  stopLossPct: 4,
  trailingPct: 3,
  sessionGoalUsd: 0,
  // Breakers ON by default: a 10% equity drawdown or a realized session loss
  // of 3% of starting equity stops the bot (and drops an in-tab key).
  maxDrawdownPct: 10,
  maxSessionLossUsd: 0,
  maxDailyLossPct: 3,
};

export const DEFAULT_RISK: BotRisk = {
  minTradeUsd: DEFAULT_MIN_TRADE_USD,
  maxPositionUsd: DEFAULT_MAX_POSITION_USD,
  operationalReserveUsd: DEFAULT_OPERATIONAL_RESERVE_USD,
  maxImpactPct: 3,
  // Pacing: thin WAX books (main LEEF/WAX pool ≈ $1.6k TVL) don't refill
  // fast enough for 120 clips/hour; 20/h with a 30 s cooldown keeps the bot
  // from walking its own price. The sliders still go higher.
  cooldownSec: 30,
  maxTradesHour: 20,
  slippage: 0.6,
  // Dead books make a step-function series: one print can fake a confident
  // blend. 65 + the 2-print confirmation rule keeps dust wiggles out.
  minConfidence: 65,
  // Quote→sign latency is 2–4 s; the arb is enforced on-chain, so a higher
  // floor only skips dust. 0.3 let phantom spreads through on stale books.
  minEdgePct: 0.45,
  gridStepPct: 2.5,
  // Two 0.3% LP tiers + impact typically cost 0.6–1.5%. Inside this budget
  // a volume echo is "zero-loss average" after fees — the on-chain min-out
  // still reverts anything worse. Not wash trading: cost is bounded.
  maxEchoLossPct: 1.5,
  // OFF-BY-DESIGN (evidence, audit C6): the chain's median swap is $0.005
  // and pools see 45-min trade droughts — printing tape on a book nobody
  // else touches buys nothing. Even 10 min of quiet gated the WHOLE session
  // on dead books ("no third-party swap observed this session"), so nothing
  // ever traded. Disabled pending more tape data; the echo budget below
  // still bounds what volume strategies may spend.
  volumeFlowGateMin: 0,
  echoBudgetUsd: 5,
  // OFF-BY-DESIGN (evidence, audit C6): the exact-quote gate enforces
  // guaranteedOut ≥ minNetEdgePct, and a 0.1% floor needs a 0.3% CLMM clip
  // to land its min-out within 0.2% — that combination almost never exists
  // on WAX micro books, so every candidate was vetoed ("guaranteed −1.27%
  // < floor 0.1%"). 0 = the exact-gate floor IS the on-chain min-out by
  // design (always satisfied by construction, still never loss-making).
  minNetEdgePct: 0,
  maxQuoteAgeSec: 45,
  maxHops: 4,
  maxPoolSharePct: 5,
};

export type Position = {
  /** Amount of the base token held (legacy field name `amountLeef`). */
  amountLeef: number;
  entryUsd: number;
  entryCostUsd: number;
  /** Amount of the quote token spent to enter (legacy field name `entryWax`). */
  entryWax: number;
  since: number;
  highUsd: number;
  mode: "paper" | "live";
  predEdgePct?: number;
  strategy?: BotStrategy;
};

export type PricePoint = { t: number; usd: number };
