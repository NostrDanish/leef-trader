import { Bar, BarChart, CartesianGrid, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { fmtUsd } from "@/lib/leef/format";
import { ChartFrame } from "./chart-frame";

export type MixRow = { name: string; tvl: number; vol: number };

const tooltipStyle = {
  background: "var(--color-surface-2)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 12,
};

/** recharts bar chart, split out so the overview shell can paint without it. */
export function LiquidityMix({ rows }: { rows: MixRow[] }) {
  return (
    <ChartFrame className="h-72">
      <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 12 }}>
        <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 6" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => `$${Math.round(v)}`}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={96}
          tick={{ fill: "var(--color-muted)", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <RTooltip
          cursor={{ fill: "var(--color-surface-2)" }}
          contentStyle={tooltipStyle}
          formatter={(v, name) => [
            fmtUsd(Number(v), 2),
            name === "tvl" ? "TVL" : "24h vol",
          ]}
        />
        <Bar dataKey="tvl" fill="var(--color-accent)" radius={[0, 4, 4, 0]} barSize={10} />
        <Bar dataKey="vol" fill="var(--color-wax)" radius={[0, 4, 4, 0]} barSize={10} />
      </BarChart>
    </ChartFrame>
  );
}
