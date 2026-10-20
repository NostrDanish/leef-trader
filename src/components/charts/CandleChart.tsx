import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CandlestickSeries,
  createChart,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { Card } from "@/components/ui/card";
import {
  fetchLeefCandles,
  type CandleResolution,
  type CandleResult,
} from "@/lib/market/candles";
import { cn } from "@/lib/utils";
import { ChartEmpty, ChartError, ChartSkeleton, FreshnessNote } from "./chart-state";

const RESOLUTIONS: { value: CandleResolution; label: string }[] = [
  { value: 15, label: "15m" },
  { value: 60, label: "1h" },
  { value: 240, label: "4h" },
];

/** How far back to ask for, per resolution (~2–5 days of candles). */
const LOOKBACK_CANDLES = 300;

const SOURCE_LABEL: Record<CandleResult["source"], string> = {
  "alcor-swap": "Alcor swap pool #217",
  "alcor-spot": "Alcor spot market #119",
};

/** Theme-matched chart options (kept in sync with src/index.css tokens). */
function chartOptions() {
  return {
    autoSize: true,
    layout: {
      background: { color: "transparent" },
      textColor: "#707886",
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      fontSize: 11,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: "rgba(30, 36, 48, 0.5)" },
      horzLines: { color: "rgba(30, 36, 48, 0.5)" },
    },
    timeScale: {
      borderColor: "#1e2430",
      timeVisible: true,
      secondsVisible: false,
    },
    rightPriceScale: { borderColor: "#1e2430" },
    crosshair: {
      vertLine: { color: "#3a4356", labelBackgroundColor: "#1f2531" },
      horzLine: { color: "#3a4356", labelBackgroundColor: "#1f2531" },
    },
  } as const;
}

/**
 * Real LEEF/WAX candlesticks (lightweight-charts) fed by the candles
 * contract lib. Polls every 60s; skeleton on first load, honest error and
 * empty states otherwise — stale data is never dressed up as live.
 */
export function CandleChart() {
  const [resolution, setResolution] = useState<CandleResolution>(60);
  const q = useQuery({
    queryKey: ["leef-candles", resolution],
    queryFn: () => {
      const to = Date.now();
      const from = to - resolution * 60_000 * LOOKBACK_CANDLES;
      return fetchLeefCandles(resolution, from, to);
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });

  return (
    <Card className="min-w-0 p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">LEEF / WAX candles</h2>
          <p className="text-xs text-muted-foreground">
            Real OHLCV prints{q.data ? ` · ${SOURCE_LABEL[q.data.source]}` : ""}.
          </p>
        </div>
        <div className="flex rounded-lg border border-border" role="radiogroup" aria-label="Candle resolution">
          {RESOLUTIONS.map((r) => (
            <button
              key={r.value}
              type="button"
              role="radio"
              aria-checked={resolution === r.value}
              onClick={() => setResolution(r.value)}
              className={cn(
                "px-2.5 py-1 font-mono text-xs transition-colors",
                resolution === r.value
                  ? "bg-accent/15 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {q.isPending ? (
        <ChartSkeleton />
      ) : q.isError ? (
        <ChartError
          message={q.error instanceof Error ? q.error.message : "Candle fetch failed."}
          onRetry={() => void q.refetch()}
        />
      ) : q.data.candles.length === 0 ? (
        <ChartEmpty>No candles in this window — the book has not printed recently.</ChartEmpty>
      ) : (
        <>
          <CandleCanvas result={q.data} />
          <div className="mt-3 flex justify-end">
            <FreshnessNote
              fetchedAt={q.data.fetchedAt}
              source={SOURCE_LABEL[q.data.source]}
            />
          </div>
        </>
      )}
    </Card>
  );
}

function CandleCanvas({ result }: { result: CandleResult }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart: IChartApi = createChart(el, chartOptions());
    const candles: ISeriesApi<"Candlestick"> = chart.addSeries(CandlestickSeries, {
      upColor: "#2ebd85",
      downColor: "#f6465d",
      wickUpColor: "#2ebd85",
      wickDownColor: "#f6465d",
      borderVisible: false,
      priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
    });
    const volume: ISeriesApi<"Histogram"> = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.18 } });

    const seen = new Set<number>();
    const rows = result.candles
      .filter((c) => {
        const t = Math.floor(c.time / 1000);
        if (seen.has(t)) return false;
        seen.add(t);
        return Number.isFinite(c.open) && Number.isFinite(c.close);
      })
      .sort((a, b) => a.time - b.time);
    candles.setData(
      rows.map((c) => ({
        time: Math.floor(c.time / 1000) as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    volume.setData(
      rows.map((c) => ({
        time: Math.floor(c.time / 1000) as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? "rgba(46, 189, 133, 0.35)" : "rgba(246, 70, 93, 0.35)",
      })),
    );
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [result]);

  return <div ref={ref} className="h-72 w-full" />;
}
