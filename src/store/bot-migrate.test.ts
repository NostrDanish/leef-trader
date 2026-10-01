import { describe, expect, it } from "vitest";
import { useBot } from "./bot";

type Migrated = {
  goals: { maxDrawdownPct: number; maxDailyLossPct: number; takeProfitPct: number };
  risk: { maxTradesHour: number; cooldownSec: number; maxPoolSharePct: number; maxImpactPct: number };
  riskMigrationNotice: string | null;
};

const migrate = (blob: unknown, version: number) =>
  useBot.persist.getOptions().migrate!(blob, version) as Migrated;

describe("bot store v13 migration", () => {
  it("v12 blob with legacy defaults gets the safer defaults + a notice, other settings kept", () => {
    const out = migrate(
      {
        goals: { takeProfitPct: 9, maxDrawdownPct: 0 },
        risk: { minTradeUsd: 0, maxPositionUsd: 50, maxTradesHour: 120, cooldownSec: 15, maxImpactPct: 2 },
      },
      12,
    );
    expect(out.goals.takeProfitPct).toBe(9);
    expect(out.goals.maxDrawdownPct).toBe(10);
    expect(out.goals.maxDailyLossPct).toBe(3);
    expect(out.risk.maxTradesHour).toBe(20);
    expect(out.risk.cooldownSec).toBe(30);
    expect(out.risk.maxPoolSharePct).toBe(5);
    expect(out.risk.maxImpactPct).toBe(2);
    expect(out.riskMigrationNotice).toMatch(/Safer risk defaults/);
  });

  it("an explicit 0 saved AFTER v13 is respected", () => {
    const out = migrate(
      {
        goals: { maxDrawdownPct: 0, maxDailyLossPct: 0, maxSessionLossUsd: 0 },
        risk: { minTradeUsd: 0, maxPositionUsd: 50, maxTradesHour: 120, cooldownSec: 15, maxPoolSharePct: 0 },
      },
      13,
    );
    expect(out.goals.maxDrawdownPct).toBe(0);
    expect(out.goals.maxDailyLossPct).toBe(0);
    expect(out.risk.maxTradesHour).toBe(120);
    expect(out.risk.maxPoolSharePct).toBe(0);
    expect(out.riskMigrationNotice).toBeNull();
  });
});
