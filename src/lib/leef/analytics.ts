import type { LeefPool, LeefSnapshot, LiveTrade, RankedPool } from "./types";

export type MarketStats = {
  poolCount: number;
  listedCount: number;
  tvlUsd: number;
  volume24Usd: number;
  volumeWeekUsd: number;
  volumeMonthUsd: number;
  leefLocked: number;
  leefLockedUsd: number;
  waxLocked: number;
  waxLockedUsd: number;
  turnover: number;
  fee24Usd: number;
  feeApyPct: number;
  hhi: number;
  topShare: number;
  change24: number | null;
  changeWeek: number | null;
};

export type MixRow = {
  id: number;
  pair: string;
  tvlUsd: number;
  volume24Usd: number;
  share: number;
  volShare: number;
  feePct: number;
  change24: number;
  turnover: number;
  feeApyPct: number;
  leefQty: number;
};

export function sumBy<T>(rows: T[], fn: (r: T) => number): number {
  return rows.reduce((s, r) => s + (Number.isFinite(fn(r)) ? fn(r) : 0), 0);
}

export function feeApyPct(p: Pick<LeefPool, "tvlUsd" | "volume24Usd" | "feePct">): number {
  if (p.tvlUsd <= 0) return 0;
  return (p.volume24Usd * (p.feePct / 100) * 365 * 100) / p.tvlUsd;
}

export function turnoverOf(p: Pick<LeefPool, "tvlUsd" | "volume24Usd">): number {
  if (p.tvlUsd <= 0) return 0;
  return p.volume24Usd / p.tvlUsd;
}

export function marketStats(snap: LeefSnapshot): MarketStats {
  const pools = snap.pools;
  const listed = pools.filter((p) => p.tvlUsd >= 1 || p.volume24Usd >= 0.05);
  const tvlUsd = sumBy(pools, (p) => p.tvlUsd);
  const volume24Usd = sumBy(pools, (p) => p.volume24Usd);
  const volumeWeekUsd = sumBy(pools, (p) => p.volumeWeekUsd);
  const volumeMonthUsd = sumBy(pools, (p) => p.volumeUsdMonth);
  const leefLocked = sumBy(pools, (p) => p.leef.quantity);
  const waxLocked = sumBy(pools, (p) =>
    p.pair.symbol.toUpperCase() === "WAX" ? p.pair.quantity : 0,
  );
  const fee24Usd = sumBy(pools, (p) => p.volume24Usd * (p.feePct / 100));
  const hhi =
    tvlUsd > 0
      ? pools.reduce((s, p) => {
          const w = p.tvlUsd / tvlUsd;
          return s + w * w;
        }, 0)
      : 0;
  const top = [...pools].sort((a, b) => b.tvlUsd - a.tvlUsd)[0];
  const mainWax = [...pools]
    .filter((p) => p.pair.symbol.toUpperCase() === "WAX")
    .sort((a, b) => b.tvlUsd - a.tvlUsd)[0];

  return {
    poolCount: pools.length,
    listedCount: listed.length,
    tvlUsd,
    volume24Usd,
    volumeWeekUsd,
    volumeMonthUsd,
    leefLocked,
    leefLockedUsd: leefLocked * snap.leefUsd,
    waxLocked,
    waxLockedUsd: waxLocked * snap.waxUsd,
    turnover: tvlUsd > 0 ? volume24Usd / tvlUsd : 0,
    fee24Usd,
    feeApyPct: tvlUsd > 0 ? (fee24Usd * 365 * 100) / tvlUsd : 0,
    hhi,
    topShare: tvlUsd > 0 && top ? top.tvlUsd / tvlUsd : 0,
    change24: mainWax?.change24 ?? null,
    changeWeek: mainWax?.changeWeek ?? null,
  };
}

export function poolMix(pools: LeefPool[], limit = 8): { rows: MixRow[]; other: MixRow | null } {
  const tvl = sumBy(pools, (p) => p.tvlUsd) || 1;
  const vol = sumBy(pools, (p) => p.volume24Usd) || 1;
  const sorted = [...pools].sort((a, b) => b.tvlUsd - a.tvlUsd);
  const head = sorted.slice(0, limit);
  const tail = sorted.slice(limit);
  const toRow = (p: LeefPool): MixRow => ({
    id: p.id,
    pair: p.pair.symbol,
    tvlUsd: p.tvlUsd,
    volume24Usd: p.volume24Usd,
    share: p.tvlUsd / tvl,
    volShare: p.volume24Usd / vol,
    feePct: p.feePct,
    change24: p.change24,
    turnover: turnoverOf(p),
    feeApyPct: feeApyPct(p),
    leefQty: p.leef.quantity,
  });
  const rows = head.map(toRow);
  let other: MixRow | null = null;
  if (tail.length > 0) {
    const tvlUsd = sumBy(tail, (p) => p.tvlUsd);
    const volume24Usd = sumBy(tail, (p) => p.volume24Usd);
    other = {
      id: -1,
      pair: `Other (${tail.length})`,
      tvlUsd,
      volume24Usd,
      share: tvlUsd / tvl,
      volShare: volume24Usd / vol,
      feePct: 0,
      change24: 0,
      turnover: tvlUsd > 0 ? volume24Usd / tvlUsd : 0,
      feeApyPct: 0,
      leefQty: sumBy(tail, (p) => p.leef.quantity),
    };
  }
  return { rows, other };
}

export function waxBookRows(ranked: RankedPool[]): RankedPool[] {
  return ranked
    .filter((p) => p.pair.symbol.toUpperCase() === "WAX" && (p.waxPerLeef ?? 0) > 0)
    .sort((a, b) => (a.waxPerLeef ?? 0) - (b.waxPerLeef ?? 0));
}

export function tradesForPool(trades: LiveTrade[], poolId: number): LiveTrade[] {
  return trades.filter((t) => t.poolId === poolId).sort((a, b) => a.timestamp - b.timestamp);
}

export function tradeSpark(
  trades: LiveTrade[],
  poolId: number,
): { t: number; px: number; label: string }[] {
  const rows = tradesForPool(trades, poolId);
  if (rows.length < 2) return [];
  return rows.map((r) => ({
    t: r.timestamp,
    px: r.priceWax,
    label: new Date(r.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  }));
}

export function hhiLabel(hhi: number): string {
  if (hhi >= 0.25) return "Concentrated";
  if (hhi >= 0.15) return "Moderate";
  return "Dispersed";
}
