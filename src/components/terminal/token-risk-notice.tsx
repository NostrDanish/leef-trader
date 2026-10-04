import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { fetchTokenRisk } from "@/lib/leef/token-risk";
import { riskLevel, tokenId, type TokenRiskInput } from "@/lib/leef/token-risk-core";
import type { UniverseToken } from "@/lib/leef/universe";
import { cn } from "@/lib/utils";

/**
 * Advisory scam / copycat notice for the tokens of the pending swap.
 * Display only: it never disables, sizes or alters the trade, and renders
 * nothing when the screen is unavailable or everything looks ordinary.
 */
export function TokenRiskNotice({ tokens }: { tokens: (UniverseToken | undefined)[] }) {
  const ask: TokenRiskInput[] = tokens
    .filter((t): t is UniverseToken => !!t && !!t.contract)
    .map((t) => ({ symbol: t.symbol, contract: t.contract, usdPrice: t.usdPrice, tvlUsd: t.tvlUsd }));
  const key = ask.map(tokenId).sort().join(",");
  const q = useQuery({
    queryKey: ["token-risk", key],
    queryFn: () => fetchTokenRisk(ask),
    enabled: ask.length > 0,
    staleTime: 6 * 3600_000,
    retry: false,
  });
  if (!q.data) return null;
  const flagged = ask
    .map((t) => ({ t, r: q.data?.[tokenId(t)], level: riskLevel(q.data?.[tokenId(t)]) }))
    .filter((x) => x.level !== "ok");
  if (!flagged.length) return null;
  return (
    <div className="space-y-1">
      {flagged.map(({ t, r, level }) => (
        <div
          key={tokenId(t)}
          role="alert"
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
            level === "warning" ? "border-red-500/40 bg-red-500/10" : "border-amber-500/40 bg-amber-500/10",
          )}
        >
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {level === "warning" ? "Possible scam or copycat token: " : "Check this token: "}
            <b>{tokenId(t)}</b>
            {r && r.copycat >= r.scam
              ? ` may impersonate a well-known token (${Math.round(r.copycat * 100)}%).`
              : r
                ? ` shows scam-like signals (${Math.round(r.scam * 100)}%).`
                : ""}{" "}
            Verify the contract before swapping. Advisory AI screen — it does not block or change your trade.
          </span>
        </div>
      ))}
    </div>
  );
}
