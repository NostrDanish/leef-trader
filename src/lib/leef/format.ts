/** LEEF prints at 4dp (quantum 0.0001). Human quotes are per 10 million. */
export const LEEF_LOT = 10_000_000;

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
    else if (abs >= 1e-8) d = 10;
    else d = 12;
  }
  if (max !== undefined) d = Math.min(d, max);
  const minD = abs > 0 && abs < 0.01 ? Math.min(d, 4) : Math.min(d, 2);
  return n.toLocaleString(undefined, {
    minimumFractionDigits: minD,
    maximumFractionDigits: d,
  });
}

export function fmtUsd(n: number, digits?: number): string {
  if (!Number.isFinite(n)) return "$—";
  const abs = Math.abs(n);
  let d = digits;
  if (d === undefined) {
    if (abs === 0) d = 2;
    else if (abs >= 1) d = 2;
    else if (abs >= 0.01) d = 4;
    else if (abs >= 0.0001) d = 6;
    else if (abs >= 1e-8) d = 10;
    else d = 12;
  }
  if (abs > 0 && abs < 0.01) {
    return `$${n.toLocaleString(undefined, {
      minimumFractionDigits: Math.min(d, 4),
      maximumFractionDigits: d,
    })}`;
  }
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: Math.min(d, 2),
    maximumFractionDigits: d,
  })}`;
}

/** 1 LEEF USD print — never rounds a live price to $0.00. */
export function fmtLeefUsd(leefUsd: number): string {
  return fmtUsd(leefUsd);
}

/** 10,000,000 LEEF in quote units (WAX / WAXUSDC / USD). */
export function fmtLeefLot(amountPerLeef: number, digits = 6): string {
  return fmtNum(amountPerLeef * LEEF_LOT, { digits });
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
