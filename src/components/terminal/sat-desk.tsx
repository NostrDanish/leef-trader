import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { walletSession } from "@/lib/wallet/session";
import { useTerminal } from "@/store/terminal";
import {
  SAT_CONTRACT,
  buildSubscribeAction,
  isDeployed,
  lockYearsLeft,
  readBuckets,
  readLps,
  readPlans,
  readSplits,
  readSub,
  toEpochSec,
  type Plan,
} from "@/lib/sat/contract";

/**
 * SAT treasury desk: shows the leeftrader contract's subscription plans,
 * revenue split, bucket balances and Alcor-locked LP positions straight from
 * chain tables. The only write is a user-signed subscription transfer via the
 * existing Wharfkit wallet session (Cloud Wallet / Anchor) — keys never touch
 * this app. Treasury actions are bot/multisig-only and not exposed here.
 */
export function SatDesk() {
  const deployed = useQuery({ queryKey: ["sat", "deployed", SAT_CONTRACT], queryFn: () => isDeployed(), staleTime: 60_000 });
  const on = deployed.data === true;
  const plans = useQuery({ queryKey: ["sat", "plans"], queryFn: readPlans, enabled: on, staleTime: 60_000 });
  const splits = useQuery({ queryKey: ["sat", "splits"], queryFn: readSplits, enabled: on, staleTime: 60_000 });
  const buckets = useQuery({
    queryKey: ["sat", "buckets", splits.data?.map((s) => s.bucket).join(",")],
    queryFn: () => readBuckets((splits.data ?? []).map((s) => s.bucket)),
    enabled: on && !!splits.data?.length,
    staleTime: 30_000,
  });
  const lps = useQuery({ queryKey: ["sat", "lps"], queryFn: readLps, enabled: on, staleTime: 60_000 });
  const session = walletSession();
  const actor = session ? String(session.actor) : null;
  const sub = useQuery({ queryKey: ["sat", "sub", actor], queryFn: () => readSub(actor!), enabled: on && !!actor });
  const setTab = useTerminal((s) => s.setTab);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function subscribe(plan: Plan) {
    if (!session || !actor) return;
    const action = buildSubscribeAction({ actor, permission: String(session.permission), plan });
    if (!window.confirm(`Pay ${plan.price.quantity} to ${SAT_CONTRACT} for ${plan.days} days (plan ${plan.id})? Your wallet will ask you to sign.`)) return;
    setBusy(plan.id); setMsg(null);
    try {
      const r = await session.transact({ actions: [action] });
      setMsg(`Signed: ${String(r.resolved?.transaction.id ?? "submitted")}`);
      void sub.refetch();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  return (
    <div className="space-y-4 p-4 text-sm">
      <div className="flex items-center gap-2">
        <Lock className="size-4" />
        <h2 className="font-semibold"><img src="/tokens/sat-64.png" alt="SAT" width={24} height={24} className="inline-block h-6 w-6 rounded-full mr-2 align-middle" />SAT treasury · {SAT_CONTRACT}</h2>
        {deployed.isLoading ? <Loader2 className="size-3 animate-spin" /> : <Badge variant={on ? "default" : "secondary"}>{on ? "live" : "not deployed"}</Badge>}
        <Button size="sm" variant="link" className="ml-auto h-auto p-0" onClick={() => setTab("about")}>About / How it works</Button>
      </div>
      {!on && !deployed.isLoading && (
        <p className="text-muted-foreground">The leeftrader contract is not deployed on WAX yet (planned; account name is a placeholder). This desk will read its tables once it is live.</p>
      )}
      {on && (
        <>
          <section>
            <h3 className="mb-1 font-medium">Subscription plans</h3>
            {(plans.data ?? []).filter((p) => p.active).map((p) => (
              <div key={p.id} className="flex items-center justify-between border-b py-1">
                <span>Plan {p.id}: {p.price.quantity} ({p.price.contract}) · {p.days} days</span>
                <Button size="sm" disabled={!session || busy !== null} onClick={() => void subscribe(p)}>
                  {busy === p.id ? <Loader2 className="size-3 animate-spin" /> : session ? "Subscribe" : "Log in wallet"}
                </Button>
              </div>
            ))}
            {actor && <p className="mt-1 text-muted-foreground">Your subscription: {sub.data ? `plan ${sub.data.plan}, expires ${new Date(toEpochSec(sub.data.expires) * 1000).toISOString().slice(0, 16)} UTC` : "none"}</p>}
            {msg && <p className="mt-1 break-all">{msg}</p>}
          </section>
          <section>
            <h3 className="mb-1 font-medium">Revenue split</h3>
            {(splits.data ?? []).map((s) => (
              <div key={s.bucket} className="flex justify-between border-b py-1">
                <span>{s.bucket} · {(s.bps / 100).toFixed(2)}%</span>
                <span className="font-mono">{(buckets.data?.[s.bucket] ?? []).map((b) => b.balance.quantity).join(" · ") || "—"}</span>
              </div>
            ))}
          </section>
          <section>
            <h3 className="mb-1 font-medium">Locked LP positions (Alcor native lock)</h3>
            {(lps.data ?? []).length === 0 && <p className="text-muted-foreground">None yet.</p>}
            {(lps.data ?? []).map((l) => (
              <div key={l.id} className="flex justify-between border-b py-1">
                <span>Pool {l.pool_id} · ticks {l.tick_lower}…{l.tick_upper} · {l.bucket}</span>
                <span>unlocks {new Date(l.unlock * 1000).toISOString().slice(0, 10)} ({lockYearsLeft(l.unlock).toFixed(1)} y)</span>
              </div>
            ))}
            <p className="mt-1 text-muted-foreground">Liquidity cannot be removed until unlock; trading fees stay claimable by the contract and go to the team fee account.</p>
          </section>
        </>
      )}
    </div>
  );
}
