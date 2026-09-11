export function forecastIl(input: {
  depositUsd: number;
  leefChangePct: number;
  dailyVolumeUsd: number;
  days: number;
  poolTvlUsd: number;
  feePct: number;
}): {
  hodl: number;
  poolNoFees: number;
  ilPct: number;
  fees: number;
  net: number;
  apy: number;
} {
  const priceRatio = 1 + input.leefChangePct / 100;
  const ilRatio = (2 * Math.sqrt(Math.max(priceRatio, 0))) / (1 + priceRatio) - 1;
  const hodl = input.depositUsd / 2 + (input.depositUsd / 2) * priceRatio;
  const poolNoFees = hodl * (1 + ilRatio);
  const share = Math.min(
    input.depositUsd / Math.max(input.poolTvlUsd, 1),
    0.5,
  );
  const fees = input.dailyVolumeUsd * (input.feePct / 100) * input.days * share;
  const net = poolNoFees + fees;
  const apy =
    input.depositUsd > 0 && input.days > 0
      ? (fees / input.depositUsd) * (365 / input.days) * 100
      : 0;
  return { hodl, poolNoFees, ilPct: ilRatio * 100, fees, net, apy };
}
