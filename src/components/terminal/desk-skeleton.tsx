/**
 * Lightweight placeholder shown while a desk chunk is being fetched.
 * Matches the terminal aesthetic: mono type, bordered panel, pulsing rows.
 */
export function DeskSkeleton({ label = "desk" }: { label?: string }) {
  return (
    <div
      aria-busy="true"
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="mb-3 flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-subtle">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
        loading {label} …
      </div>
      <div className="space-y-2">
        <div className="h-3 w-2/3 animate-pulse rounded bg-accent/40" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-accent/30" />
        <div className="h-3 w-3/4 animate-pulse rounded bg-accent/20" />
      </div>
    </div>
  );
}
