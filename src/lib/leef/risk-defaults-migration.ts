/**
 * Persisted-state migration for the safer risk defaults (bot store v13).
 *
 * Old saves carried `maxDrawdownPct: 0` (no drawdown stop) and pacing of
 * 120 trades/hour with a 15 s cooldown because those WERE the defaults.
 * Merging `{ ...DEFAULT_GOALS, ...saved }` would keep them forever, so this
 * maps exactly those legacy values to the new defaults and explains why.
 * Anything the user changed away from the legacy defaults is left alone, and
 * a user can still set 0 (off) again after the migration.
 */
import { DEFAULT_GOALS, DEFAULT_RISK, type BotGoals, type BotRisk } from "./bot-engine";

const LEGACY_MAX_TRADES_HOUR = 120;
const LEGACY_COOLDOWN_SEC = 15;

export function migrateSaferRiskDefaults(
  goals: Partial<BotGoals> | undefined,
  risk: Partial<BotRisk> | undefined,
): { goals: Partial<BotGoals>; risk: Partial<BotRisk>; notice: string | null } {
  const g: Partial<BotGoals> = {};
  const r: Partial<BotRisk> = {};
  const changes: string[] = [];

  if (goals?.maxDrawdownPct == null || goals.maxDrawdownPct === 0) {
    g.maxDrawdownPct = DEFAULT_GOALS.maxDrawdownPct;
    changes.push(`max drawdown stop ${DEFAULT_GOALS.maxDrawdownPct}%`);
  }
  if (goals?.maxDailyLossPct == null) {
    g.maxDailyLossPct = DEFAULT_GOALS.maxDailyLossPct;
    changes.push(`session loss stop ${DEFAULT_GOALS.maxDailyLossPct}% of starting equity`);
  }
  if (goals?.maxSessionLossUsd == null) g.maxSessionLossUsd = DEFAULT_GOALS.maxSessionLossUsd;
  if (risk?.maxTradesHour == null || risk.maxTradesHour === LEGACY_MAX_TRADES_HOUR) {
    r.maxTradesHour = DEFAULT_RISK.maxTradesHour;
    changes.push(`${DEFAULT_RISK.maxTradesHour} trades/hour`);
  }
  if (risk?.cooldownSec == null || risk.cooldownSec === LEGACY_COOLDOWN_SEC) {
    r.cooldownSec = DEFAULT_RISK.cooldownSec;
    changes.push(`${DEFAULT_RISK.cooldownSec}s cooldown`);
  }
  if (risk?.maxPoolSharePct == null) {
    r.maxPoolSharePct = DEFAULT_RISK.maxPoolSharePct;
    changes.push(`position ≤ ${DEFAULT_RISK.maxPoolSharePct}% of the pool's liquidity`);
  }

  return {
    goals: g,
    risk: r,
    notice:
      changes.length > 0
        ? `Safer risk defaults applied: ${changes.join(", ")}. You can change them on the Bot desk (0 = off, unsafe).`
        : null,
  };
}
