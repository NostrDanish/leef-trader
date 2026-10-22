/**
 * Read-only client + wallet-signed action builders for the SAT / leeftrader
 * treasury contract (source: NostrDanish/leef-trader-tg contracts/leeftrader,
 * docs/CONTRACTS.md). NOT DEPLOYED YET — the account name is a placeholder,
 * overridable with VITE_SAT_CONTRACT. Reads fail soft ("not deployed").
 *
 * Only user-side actions are built here (subscription transfer, fee view).
 * Treasury actions (buyback/addlp/payout) belong to the dedicated bot account
 * and the admin multisig; the web app never builds or signs them.
 */
import { rpcPost } from "@/lib/wallet/chain";

const ENV = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
/** Owner-chosen name (11 chars: must be won in a WAX premium-name bid). 12-char fallback: smarttrader1. */
export const SAT_CONTRACT: string = ENV.VITE_SAT_CONTRACT || "smarttrader";
export const SAT_TOKEN_CONTRACT: string = ENV.VITE_SAT_TOKEN_CONTRACT || "sattokenacct";
export const ALCOR_SWAP = "swap.alcor";

export type Plan = { id: number; price: { quantity: string; contract: string }; days: number; active: number | boolean };
export type Sub = { user: string; plan: number; expires: string | number };
export type Bucket = { balance: { quantity: string; contract: string }; day: number; spent_today: number };
export type Split = { bucket: string; bps: number };
export type LpRow = { id: number; pool_id: number; tick_lower: number; tick_upper: number; unlock: number; bucket: string };
export type AlcorLock = { pos_id: number; unlockTime: number };

type Rows<T> = { rows: T[]; more?: boolean };

export async function readTable<T>(table: string, scope = SAT_CONTRACT, code = SAT_CONTRACT, limit = 100, lower?: string): Promise<T[]> {
  const r = (await rpcPost("/v1/chain/get_table_rows", {
    json: true, code, scope, table, limit, ...(lower ? { lower_bound: lower, upper_bound: lower } : {}),
  }, 10_000, "low")) as Rows<T>;
  return Array.isArray(r?.rows) ? r.rows : [];
}

export async function isDeployed(account = SAT_CONTRACT): Promise<boolean> {
  try {
    const r = (await rpcPost("/v1/chain/get_code_hash", { account_name: account }, 8_000, "low")) as { code_hash?: string };
    return !!r?.code_hash && !/^0+$/.test(r.code_hash);
  } catch { return false; }
}

export const readPlans = () => readTable<Plan>("plans");
export const readSplits = () => readTable<Split>("splits");
export const readLps = () => readTable<LpRow>("lps");
export const readSub = async (user: string) => (await readTable<Sub>("subs", SAT_CONTRACT, SAT_CONTRACT, 1, user))[0] ?? null;
export async function readBuckets(names: string[]): Promise<Record<string, Bucket[]>> {
  const out: Record<string, Bucket[]> = {};
  for (const n of names) out[n] = await readTable<Bucket>("buckets", n);
  return out;
}
/** Alcor native lock rows for one pool (swap.alcor `locks`, scope = pool id). */
export const readAlcorLocks = (poolId: number) => readTable<AlcorLock>("locks", String(poolId), ALCOR_SWAP, 200);

const NAME_RE = /^[a-z1-5.]{1,12}[a-j1-5]?$/;
export function assertName(n: string): void {
  if (!NAME_RE.test(n) || n.endsWith(".")) throw new Error(`invalid account name: ${n}`);
}

/** Subscription memo understood by leeftrader on_notify: `sub:<plan>[:<user>]`. */
export function subMemo(planId: number, beneficiary?: string): string {
  if (!Number.isInteger(planId) || planId < 0) throw new Error("bad plan id");
  if (beneficiary) { assertName(beneficiary); return `sub:${planId}:${beneficiary}`; }
  return `sub:${planId}`;
}

export type ActionSpec = { account: string; name: string; authorization: { actor: string; permission: string }[]; data: Record<string, unknown> };

/** Wallet-signed subscription payment: a plain token transfer to the contract. */
export function buildSubscribeAction(opts: { actor: string; permission?: string; plan: Plan; beneficiary?: string }): ActionSpec {
  assertName(opts.actor);
  if (!opts.plan.active) throw new Error("plan inactive");
  return {
    account: opts.plan.price.contract,
    name: "transfer",
    authorization: [{ actor: opts.actor, permission: opts.permission ?? "active" }],
    data: { from: opts.actor, to: SAT_CONTRACT, quantity: opts.plan.price.quantity, memo: subMemo(opts.plan.id, opts.beneficiary) },
  };
}

export function toEpochSec(v: string | number): number {
  if (typeof v === "number") return v > 1e11 ? Math.floor(v / 1e6) : v; // time_point (µs) or seconds
  const t = Date.parse(v.endsWith("Z") ? v : `${v}Z`);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}
export function lockYearsLeft(unlock: string | number, nowSec = Date.now() / 1000): number {
  return Math.max(0, (toEpochSec(unlock) - nowSec) / (365.25 * 86400));
}
