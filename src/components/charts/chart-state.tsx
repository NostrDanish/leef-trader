import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { relTime, useNow } from "@/components/terminal/use-now";

/**
 * Shared honest-state primitives for the real-data charts (SPEC U1):
 * loading skeleton while the first fetch is in flight, an explicit error
 * panel on failure (never stale-as-live), and a source-attributed freshness
 * footer once data lands.
 */

export function ChartSkeleton({ className = "h-72" }: { className?: string }) {
  return (
    <div aria-busy="true" className={className}>
      <div className="flex h-full flex-col justify-end gap-2 pb-2">
        <div className="h-3 w-1/3 animate-pulse rounded bg-surface-3" />
        <div className="h-2/3 w-full animate-pulse rounded bg-surface-2" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-surface-3" />
      </div>
    </div>
  );
}

export function ChartError({
  message,
  onRetry,
  className = "h-72",
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-warn/30 bg-warn/5 p-6 text-center ${className}`}
    >
      <AlertTriangle className="size-5 text-warn" />
      <p className="max-w-md text-sm text-muted-foreground">
        Live data unavailable — nothing is shown from cache or guesswork. {message}
      </p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-3.5" />
          Retry
        </Button>
      )}
    </div>
  );
}

export function ChartEmpty({
  children,
  className = "h-72",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center justify-center rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground ${className}`}
    >
      {children}
    </div>
  );
}

/** "updated 12s ago · source: …" — the never-stale-as-live receipt. */
export function FreshnessNote({
  fetchedAt,
  source,
}: {
  fetchedAt: number;
  source: string;
}) {
  const now = useNow(5000);
  return (
    <span className="font-mono text-[11px] text-subtle">
      updated {relTime(fetchedAt, now)} · source: {source}
    </span>
  );
}
