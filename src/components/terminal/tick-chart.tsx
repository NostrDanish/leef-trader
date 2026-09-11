import { useMemo } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartPoint, IndicatorId } from "@/lib/leef/indicators";
import { fmtNum } from "@/lib/leef/format";

const tooltipStyle = {
  background: "var(--color-surface-2)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 12,
};

export function PriceChart({
  points,
  engines,
  unit,
}: {
  points: ChartPoint[];
  engines: Record<IndicatorId, boolean>;
  unit: string;
}) {
  const data = useMemo(() => points.slice(-180), [points]);
  const xEvery = Math.max(8, Math.floor(Math.max(data.length - 1, 1) / 5));
  return (
    <div className="h-72 sm:h-80">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="tickFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 6" />
          <XAxis
            dataKey="label"
            tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            interval={xEvery}
            minTickGap={36}
          />
          <YAxis
            yAxisId="px"
            domain={["auto", "auto"]}
            tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={56}
            tickFormatter={(v: number) => fmtNum(v, { digits: 2 })}
          />
          <YAxis
            yAxisId="vol"
            orientation="right"
            hide
            domain={[0, (max: number) => max * 4]}
          />
          <RTooltip
            contentStyle={tooltipStyle}
            formatter={(v, name) => [fmtNum(Number(v), { digits: 3 }), String(name)]}
            labelFormatter={(_, payload) => {
              const row = payload?.[0]?.payload as ChartPoint | undefined;
              return row ? `${row.label} UTC · ${unit}` : "";
            }}
          />
          <Bar yAxisId="vol" dataKey="v" fill="var(--color-surface-3)" name="Vol" isAnimationActive={false} />
          <Area
            yAxisId="px"
            type="monotone"
            dataKey="c"
            stroke="var(--color-accent)"
            fill="url(#tickFill)"
            strokeWidth={2}
            name="Last"
            dot={false}
            isAnimationActive={false}
          />
          {engines.bb && (
            <Line
              yAxisId="px"
              type="monotone"
              dataKey="bbUpper"
              stroke="var(--color-muted)"
              strokeDasharray="4 4"
              dot={false}
              name="BB upper"
              isAnimationActive={false}
            />
          )}
          {engines.bb && (
            <Line
              yAxisId="px"
              type="monotone"
              dataKey="bbLower"
              stroke="var(--color-muted)"
              strokeDasharray="4 4"
              dot={false}
              name="BB lower"
              isAnimationActive={false}
            />
          )}
          {engines.bb && (
            <Line
              yAxisId="px"
              type="monotone"
              dataKey="bbMid"
              stroke="var(--color-muted)"
              strokeWidth={1}
              dot={false}
              name="BB mid"
              isAnimationActive={false}
            />
          )}
          {engines.ema && (
            <Line
              yAxisId="px"
              type="monotone"
              dataKey="ema"
              stroke="var(--color-leef)"
              strokeWidth={1.5}
              dot={false}
              name="EMA"
              isAnimationActive={false}
            />
          )}
          {engines.sma && (
            <Line
              yAxisId="px"
              type="monotone"
              dataKey="sma"
              stroke="var(--color-wax)"
              strokeWidth={1.5}
              dot={false}
              name="SMA"
              isAnimationActive={false}
            />
          )}
          {engines.vwap && (
            <Line
              yAxisId="px"
              type="monotone"
              dataKey="vwap"
              stroke="var(--color-warn)"
              strokeDasharray="5 4"
              dot={false}
              name="VWAP"
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MacdPane({ points }: { points: ChartPoint[] }) {
  const data = useMemo(() => points.slice(-180), [points]);
  return (
    <div className="h-28">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 6" />
          <XAxis dataKey="label" hide />
          <YAxis
            tick={{ fill: "var(--color-subtle)", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={56}
            tickFormatter={(v: number) => v.toFixed(2)}
          />
          <RTooltip contentStyle={tooltipStyle} />
          <ReferenceLine y={0} stroke="var(--color-border)" />
          <Bar dataKey="macdHist" name="Hist" fill="var(--color-accent)" isAnimationActive={false} />
          <Line
            type="monotone"
            dataKey="macd"
            stroke="var(--color-leef)"
            dot={false}
            name="MACD"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="macdSignal"
            stroke="var(--color-wax)"
            dot={false}
            name="Signal"
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function RsiPane({ points }: { points: ChartPoint[] }) {
  const data = useMemo(() => points.slice(-180), [points]);
  return (
    <div className="h-24">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 6" />
          <XAxis dataKey="label" hide />
          <YAxis
            domain={[0, 100]}
            ticks={[30, 50, 70]}
            tick={{ fill: "var(--color-subtle)", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={56}
          />
          <RTooltip contentStyle={tooltipStyle} />
          <ReferenceLine y={70} stroke="var(--color-sell)" strokeDasharray="3 3" />
          <ReferenceLine y={30} stroke="var(--color-buy)" strokeDasharray="3 3" />
          <Line
            type="monotone"
            dataKey="rsi"
            stroke="var(--color-accent)"
            dot={false}
            name="RSI"
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
