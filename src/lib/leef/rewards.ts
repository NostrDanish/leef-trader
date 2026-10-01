/**
 * Claimable rewards — read-only discovery + claim action builders.
 *
 *  - LEEF staking rewards: `leefrewarder` table `rewards` (row per user,
 *    `unclaimed_reward`), claimed with `leefrewarder::claim { user }`.
 *  - Alcor farm incentives for staked LP positions: `swap.alcor` tables
 *    `stakingpos` (posId → incentiveIds), `incentives`, and `stakes`
 *    (scope = incentive id), claimed with `swap.alcor::getreward`.
 *
 * Claim only: this module never stakes, unstakes, locks or moves funds.
 * Pending incentive math mirrors the contract's reward-per-token accrual
 * (BigInt, 1e18 fixed point) so the UI shows what a claim would pay.
 */
import { rpcPost } from "@/lib/wallet/chain";
import { LEEF_REWARDER } from "@/lib/wallet/policy";

export type RewardItem =
  | {
      kind: "leefrewarder";
      /** Asset string, e.g. "1234.5678 LEEF". */
      quantity: string;
      amount: number;
      symbol: string;
      contract: string;
    }
  | {
      kind: "alcor";
      incentiveId: number;
      posId: number;
      poolId: number;
      amount: number;
      symbol: string;
      contract: string;
      decimals: number;
      /** Unix seconds when the incentive period ends. */
      periodFinish: number;
    };

type IncentiveRow = {
  id?: number | string;
  poolId?: number | string;
  reward?: { quantity?: string; contract?: string };
  periodFinish?: number | string;
  rewardRateE18?: string | number;
  rewardPerTokenStored?: string | number;
  totalStakingWeight?: string | number;
  lastUpdateTime?: number | string;
};

type StakeRow = {
  posId?: number | string;
  stakingWeight?: string | number;
  userRewardPerTokenPaid?: string | number;
  rewards?: string | number;
};

const big = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? "0").split(".")[0] || "0");
  } catch {
    return 0n;
  }
};

/**
 * Pure: pending reward (raw units) of one staked position in one incentive,
 * at `nowSec`. Reward-per-token accrues at rewardRateE18 / totalWeight until
 * periodFinish; the stake earns weight × (rpt − paid) / 1e18 on top of its
 * stored `rewards`.
 */
export function pendingIncentiveRaw(inc: IncentiveRow, stk: StakeRow, nowSec: number): bigint {
  const totalWeight = big(inc.totalStakingWeight);
  const t = BigInt(Math.min(Math.floor(nowSec), Number(inc.periodFinish ?? 0)));
  const last = big(inc.lastUpdateTime);
  let rpt = big(inc.rewardPerTokenStored);
  if (totalWeight > 0n && t > last) rpt += (big(inc.rewardRateE18) * (t - last)) / totalWeight;
  const earned = (big(stk.stakingWeight) * (rpt - big(stk.userRewardPerTokenPaid))) / 10n ** 18n;
  const total = big(stk.rewards) + earned;
  return total > 0n ? total : 0n;
}

/** "12.3400 LEEF" → { amount, symbol, decimals } */
export function parseRewardAsset(q: string | undefined): { amount: number; symbol: string; decimals: number } | null {
  const m = String(q ?? "").trim().match(/^(\d+)(?:\.(\d+))?\s+([A-Z0-9]{1,7})$/);
  if (!m) return null;
  return { amount: Number(`${m[1]}.${m[2] ?? "0"}`), symbol: m[3]!, decimals: (m[2] ?? "").length };
}

type Rows<T> = { rows?: T[] };

async function tableRow<T>(code: string, scope: string, table: string, key: string): Promise<T | null> {
  const raw = (await rpcPost(
    "/v1/chain/get_table_rows",
    { json: true, code, scope, table, lower_bound: key, upper_bound: key, limit: 1 },
    10_000,
    "low",
  )) as Rows<T>;
  return raw.rows?.[0] ?? null;
}

/** LEEF staking reward waiting in `leefrewarder` for `account` (null when none). */
export async function fetchRewarderClaimable(account: string): Promise<RewardItem | null> {
  const row = await tableRow<{ username?: string; unclaimed_reward?: string }>(
    LEEF_REWARDER,
    LEEF_REWARDER,
    "rewards",
    account,
  );
  if (!row || row.username !== account) return null;
  const a = parseRewardAsset(row.unclaimed_reward);
  if (!a || !(a.amount > 0)) return null;
  return {
    kind: "leefrewarder",
    quantity: row.unclaimed_reward!,
    amount: a.amount,
    symbol: a.symbol,
    contract: "leefmaincorp",
  };
}

/** Pending Alcor incentive rewards for the given (owned) position ids. */
export async function fetchAlcorIncentiveRewards(posIds: number[], nowSec = Date.now() / 1000): Promise<RewardItem[]> {
  const out: RewardItem[] = [];
  for (const posId of posIds) {
    const sp = await tableRow<{ posId?: number | string; incentiveIds?: (number | string)[] }>(
      "swap.alcor",
      "swap.alcor",
      "stakingpos",
      String(posId),
    );
    if (!sp || Number(sp.posId) !== posId) continue; // not staked in any farm
    for (const iidRaw of sp.incentiveIds ?? []) {
      const iid = Number(iidRaw);
      const [inc, stk] = await Promise.all([
        tableRow<IncentiveRow>("swap.alcor", "swap.alcor", "incentives", String(iid)),
        tableRow<StakeRow>("swap.alcor", String(iid), "stakes", String(posId)),
      ]);
      if (!inc || !stk || Number(stk.posId) !== posId) continue;
      const asset = parseRewardAsset(inc.reward?.quantity);
      if (!asset) continue;
      const raw = pendingIncentiveRaw(inc, stk, nowSec);
      if (raw <= 0n) continue;
      out.push({
        kind: "alcor",
        incentiveId: iid,
        posId,
        poolId: Number(inc.poolId ?? 0),
        amount: Number(raw) / 10 ** asset.decimals,
        symbol: asset.symbol,
        contract: String(inc.reward?.contract ?? ""),
        decimals: asset.decimals,
        periodFinish: Number(inc.periodFinish ?? 0),
      });
    }
  }
  return out;
}

/** Plain action list for claiming `items` as `account` (fed to the signer/firewall). */
export function claimActionsFor(
  account: string,
  items: RewardItem[],
): ({ contract: "leefrewarder"; name: "claim"; data: { user: string } } | {
  contract: "swap.alcor";
  name: "getreward";
  data: { incentiveId: number; posId: number };
})[] {
  const acts: ReturnType<typeof claimActionsFor> = [];
  if (items.some((i) => i.kind === "leefrewarder")) {
    acts.push({ contract: "leefrewarder", name: "claim", data: { user: account } });
  }
  const seen = new Set<string>();
  for (const i of items) {
    if (i.kind !== "alcor") continue;
    const k = `${i.incentiveId}:${i.posId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    acts.push({ contract: "swap.alcor", name: "getreward", data: { incentiveId: i.incentiveId, posId: i.posId } });
  }
  return acts;
}
