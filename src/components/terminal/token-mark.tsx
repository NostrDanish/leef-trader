import { cn } from "@/lib/utils";

export function TokenMark({
  symbol,
  size = "md",
}: {
  symbol: string;
  size?: "sm" | "md" | "lg";
}) {
  const s = symbol.toUpperCase();
  const isLeef = s === "LEEF";
  const isWax = s === "WAX" || s === "WAXP";
  const dim =
    size === "lg" ? "size-10 text-sm" : size === "sm" ? "size-6 text-xs" : "size-8 text-xs";
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full border font-mono font-medium",
        dim,
        isLeef && "border-leef/40 bg-leef/15 text-leef",
        isWax && "border-wax/40 bg-wax/15 text-wax",
        !isLeef && !isWax && "border-border bg-surface-2 text-muted-foreground",
      )}
    >
      {isLeef ? "L" : isWax ? "W" : s.slice(0, 1)}
    </span>
  );
}

export function PairMarks({ pair }: { pair: string }) {
  return (
    <span className="flex -space-x-2">
      <TokenMark symbol="LEEF" size="sm" />
      <TokenMark symbol={pair} size="sm" />
    </span>
  );
}
