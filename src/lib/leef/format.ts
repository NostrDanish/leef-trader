export function fmtNum(
  n: number,
  opts: { digits?: number; compact?: boolean; max?: number } = {},
): string {
  if (!Number.isFinite(n)) return "—";
  const { digits, compact, max } = opts;
  if (compact && Math.abs(n) >= 1_000_000) {
    return n.toLocaleString(undefined, {
      notation: "compact",
      maximumFractionDigits: 2,
    });
  }
  const abs = Math.abs(n);
  let d = digits;
  if (d === undefined) {
    if (abs === 0) d = 2;
    else if (abs >= 1000) d = 2;
    else if (abs >= 1) d = 4;
    else if (abs >= 0.0001) d = 6;
    else d = 8;
  }
  if (max !== undefined) d = Math.min(d, max);
  return n.toLocaleString(undefined, {
    minimumFractionDigits: Math.min(d, 2),
    maximumFractionDigits: d,
  });
}

export function fmtUsd(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "$—";
  if (Math.abs(n) > 0 && Math.abs(n) < 0.01) {
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
  }
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function fmtPct(n: number, digits = 2, signed = true): string {
  if (!Number.isFinite(n)) return "—";
  const v = n * 100;
  const sign = signed && v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

export function fmtPctPts(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

export function shortHash(h: string): string {
  if (h.length <= 12) return h;
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

export function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function waxPerMillion(waxPerLeef: number | null): number | null {
  if (waxPerLeef == null) return null;
  return waxPerLeef * 1_000_000;
}
