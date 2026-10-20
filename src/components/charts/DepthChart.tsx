import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/card";
import { ChartFrame } from "@/components/terminal/chart-frame";
import { fetchLeefDepth, type DepthResult } from "@/lib/market/depth";
import { fmtNum } from "@/lib/leef/format";
import { ChartEmpty, ChartError, ChartSkeleton, FreshnessNote } from "./chart-state";

const SOURCE_LABEL: Record<DepthResult["source"], string> = {
  "alcor-spot": "Alcor spot order book · market #119",
  "alcor-amm": "AMM liquidity curve · pool #217",
};

/**
 * Real order-book depth (bids/asks cumulative) from the depth contract lib.
 * When the source is the AMM fallback the panel is explicitly labeled as
 * liquidity-curve-derived — never passed off as a limit-order book.
 */
export function DepthChart() {
  const q = useQuery({
    queryKey: ["leef-depth"],
    queryFn: () => fetchLeefDepth(),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1,
  });

  return (
    <Card className="min-w-0 p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Order-book depth</h2>
          <p className="text-xs text-muted-foreground">
            {q.data?.source === "alcor-amm"
              ? "Derived from the live AMM liquidity curve — not a limit-order book."
              : "Real resting bids and asks, cumulative LEEF depth."}
          </p>
        </div>
        {q.data && <FreshnessNote fetchedAt={q.data.fetchedAt} source={SOURCE_LABEL[q.data.source]} />}
      </div>

      {q.isPending ? (
        <ChartSkeleton className="h-64" />
      ) : q.isError ? (
        <ChartError
          className="h-64"
          message={q.error instanceof Error ? q.error.message : "Depth fetch failed."}
          onRetry={() => void q.refetch()}
        />
      ) : q.data.bids.length === 0 && q.data.asks.length === 0 ? (
        <ChartEmpty className="h-64">Book is empty — no resting depth on this market.</ChartEmpty>
      ) : (
        <DepthCanvas result={q.data} />
      )}
    </Card>
  );
}

/** Cumulative quantity per side from raw levels (module scope: mutation-safe). */
function cumulate(levels: DepthResult["bids"], desc: boolean) {
  const sorted = [...levels].sort((a, b) => (desc ? b.price - a.price : a.price - b.price));
  const out: { price: number; total: number }[] = [];
  let sum = 0;
  for (const l of sorted) {
    sum += l.quantity;
    out.push({ price: l.price, total: sum });
  }
  return out;
}

function DepthCanvas({ result }: { result: DepthResult }) {
  const rows = useMemo(() => {
    // Cumulative quantity per side, computed from raw levels so the chart is
    // correct regardless of how the producer fills `total`.
    const byPrice = new Map<number, { price: number; bid?: number; ask?: number }>();
    for (const b of cumulate(result.bids, true)) {
      byPrice.set(b.price, { price: b.price, bid: b.total });
    }
    for (const a of cumulate(result.asks, false)) {
      const row = byPrice.get(a.price) ?? { price: a.price };
      row.ask = a.total;
      byPrice.set(a.price, row);
    }
    return [...byPrice.values()].sort((x, y) => x.price - y.price);
  }, [result]);

  return (
    <ChartFrame className="h-64">
      <AreaChart data={rows} margin={{ left: 4, right: 8, top: 4, bottom: 0 }}>
        <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 6" />
        <XAxis
          dataKey="price"
          type="number"
          domain={["dataMin", "dataMax"]}
          tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => fmtNum(v, { digits: 8 })}
        />
        <YAxis
          tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={64}
          tickFormatter={(v: number) => fmtNum(v, { compact: true })}
        />
        <RTooltip
          contentStyle={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            fontSize: 12,
          }}
          formatter={(v, name) => [
            // AMM fallback levels are raw liquidity L, not LEEF amounts.
            `${fmtNum(Number(v), { compact: true })} ${
              result.unit === "liquidity" ? "liquidity units" : "LEEF"
            }`,
            name === "bid" ? "Bid depth" : "Ask depth",
          ]}
          labelFormatter={(l) => `${fmtNum(Number(l), { digits: 8 })} WAX/LEEF`}
        />
        {result.mid != null && (
          <ReferenceLine
            x={result.mid}
            stroke="var(--color-wax)"
            strokeDasharray="4 4"
            label={{
              value: "mid",
              fill: "var(--color-wax)",
              fontSize: 10,
              position: "insideTopRight",
            }}
          />
        )}
        <Area
          type="stepAfter"
          dataKey="bid"
          stroke="var(--color-buy)"
          fill="var(--color-buy)"
          fillOpacity={0.16}
          strokeWidth={1.5}
          connectNulls
        />
        <Area
          type="stepAfter"
          dataKey="ask"
          stroke="var(--color-sell)"
          fill="var(--color-sell)"
          fillOpacity={0.16}
          strokeWidth={1.5}
          connectNulls
        />
      </AreaChart>
    </ChartFrame>
  );
}
