import type { AuxPool, LeefPool, LeefSnapshot, LiveTrade } from "./types";
import type { UniverseToken } from "./universe";
import { emptyToken } from "./amm";

function leefPool(p: {
  id: number;
  fee: number;
  leefQty: number;
  pair: { symbol: string; contract: string; decimals: number; quantity: number };
  tvlUsd: number;
  volume24Usd: number;
  volumeWeekUsd?: number;
  volumeUsdMonth?: number;
  change24?: number;
  changeWeek?: number;
  leefIsA?: boolean;
}): LeefPool {
  const pairPerLeef = p.leefQty > 0 ? p.pair.quantity / p.leefQty : 0;
  const isWax = p.pair.symbol === "WAX";
  const volumeWeekUsd = p.volumeWeekUsd ?? p.volume24Usd * 7;
  return {
    id: p.id,
    fee: p.fee,
    feePct: p.fee / 10_000,
    leef: emptyToken("LEEF", "leefmaincorp", 4, p.leefQty),
    pair: emptyToken(p.pair.symbol, p.pair.contract, p.pair.decimals, p.pair.quantity),
    leefIsA: p.leefIsA ?? false,
    tvlUsd: p.tvlUsd,
    volume24Usd: p.volume24Usd,
    volumeWeekUsd,
    volumeUsdMonth: p.volumeUsdMonth ?? p.volume24Usd * 20,
    volumeUsd90: (p.volumeUsdMonth ?? p.volume24Usd * 20) * 2.2,
    volumeLeef24: 0,
    volumePair24: 0,
    change24: p.change24 ?? 0,
    changeWeek: p.changeWeek ?? 0,
    liquidity: "0",
    pairPerLeef,
    leefPerPair: pairPerLeef > 0 ? 1 / pairPerLeef : 0,
    waxPerLeef: isWax ? pairPerLeef : null,
    usdPerLeef: null,
  };
}

/** Last known Alcor book (leefmaincorp). Used when the live API is unreachable. */
export function fallbackPools(): LeefPool[] {
  return [
    leefPool({
      id: 217,
      fee: 3000,
      leefQty: 4_244_218_205.2964,
      pair: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: 104_467.18874318 },
      tvlUsd: 1267.39,
      volume24Usd: 223.73,
      volumeWeekUsd: 2661.68,
      volumeUsdMonth: 4677,
      change24: 1.21,
      changeWeek: 15.34,
    }),
    leefPool({
      id: 8425,
      fee: 10000,
      leefQty: 1_322_581_825.94,
      pair: { symbol: "WAXUSDC", contract: "eth.token", decimals: 6, quantity: 237.13 },
      tvlUsd: 480.15,
      volume24Usd: 31.36,
      change24: -0.4,
    }),
    leefPool({
      id: 1174,
      fee: 3000,
      leefQty: 287_738_228.47,
      pair: { symbol: "USDT", contract: "usdt.alcor", decimals: 4, quantity: 57.57 },
      tvlUsd: 110.77,
      volume24Usd: 24.54,
      change24: 0.8,
    }),
    leefPool({
      id: 1015,
      fee: 10000,
      leefQty: 405_972_943.1429,
      pair: { symbol: "WAX", contract: "eosio.token", decimals: 8, quantity: 15_326.83809896 },
      tvlUsd: 145.87,
      volume24Usd: 13.11,
      volumeWeekUsd: 32.91,
      change24: -2.1,
    }),
    leefPool({
      id: 3273,
      fee: 10000,
      leefQty: 818_598_206.96,
      pair: { symbol: "LSW", contract: "lsw.alcor", decimals: 8, quantity: 26_379.99 },
      tvlUsd: 301.27,
      volume24Usd: 4.06,
    }),
    leefPool({
      id: 230,
      fee: 3000,
      leefQty: 181_802_511.36,
      pair: { symbol: "TLM", contract: "alien.worlds", decimals: 4, quantity: 22_897.15 },
      tvlUsd: 67.08,
      volume24Usd: 9.25,
    }),
    leefPool({
      id: 11502,
      fee: 3000,
      leefQty: 109_609_197.57,
      pair: { symbol: "NBG", contract: "newb.gm", decimals: 4, quantity: 20_357.91 },
      tvlUsd: 40.51,
      volume24Usd: 6.78,
    }),
    leefPool({
      id: 6019,
      fee: 3000,
      leefQty: 85_298_426.38,
      pair: { symbol: "BUZZ", contract: "buzztoken.gm", decimals: 4, quantity: 19_982_530.86 },
      tvlUsd: 31.53,
      volume24Usd: 3.85,
    }),
    leefPool({
      id: 219,
      fee: 3000,
      leefQty: 195_048_001.1232,
      pair: { symbol: "BJ", contract: "blowjobtoken", decimals: 4, quantity: 41_827_976.3671 },
      tvlUsd: 18.4,
      volume24Usd: 1.83,
    }),
    leefPool({
      id: 10491,
      fee: 3000,
      leefQty: 131_520_935.47,
      pair: { symbol: "WAXUSDC", contract: "eth.token", decimals: 6, quantity: 10.25 },
      tvlUsd: 34.51,
      volume24Usd: 1.6,
    }),
    leefPool({
      id: 10765,
      fee: 3000,
      leefQty: 71_169_922.68,
      pair: { symbol: "LSW", contract: "lsw.alcor", decimals: 8, quantity: 2308.69 },
      tvlUsd: 26.28,
      volume24Usd: 1.32,
    }),
    leefPool({
      id: 9165,
      fee: 10000,
      leefQty: 84_645_452.29,
      pair: { symbol: "CHEESE", contract: "cheesetoken", decimals: 4, quantity: 2300.41 },
      tvlUsd: 31.21,
      volume24Usd: 1.11,
    }),
    leefPool({
      id: 625,
      fee: 3000,
      leefQty: 15_192_772.3925,
      pair: { symbol: "SHING", contract: "t.taco", decimals: 4, quantity: 12_451_951.9988 },
      tvlUsd: 4.2,
      volume24Usd: 0.056,
    }),
    leefPool({
      id: 220,
      fee: 3000,
      leefQty: 41_776_669.97,
      pair: { symbol: "DUST", contract: "niftywizards", decimals: 4, quantity: 597_832.31 },
      tvlUsd: 6.1,
      volume24Usd: 0.067,
    }),
    leefPool({
      id: 226,
      fee: 3000,
      leefQty: 17_155_208.9936,
      pair: { symbol: "TACO", contract: "t.taco", decimals: 4, quantity: 1794.531 },
      tvlUsd: 3.4,
      volume24Usd: 0.05,
    }),
    leefPool({
      id: 1713,
      fee: 10000,
      leefQty: 1_877_656.68,
      pair: { symbol: "WUF", contract: "wuffi", decimals: 4, quantity: 20_578_395.88 },
      tvlUsd: 0.7,
      volume24Usd: 0.16,
    }),
  ];
}

export function fallbackAux(): AuxPool[] {
  return [
    {
      id: 1095,
      fee: 3000,
      feePct: 0.3,
      tokenA: emptyToken("WAX", "eosio.token", 8, 222_565.77920779),
      tokenB: emptyToken("USDT", "usdt.alcor", 4, 750.6024),
      tvlUsd: 1780.88,
      volume24Usd: 260.78,
    },
    {
      id: 32,
      fee: 3000,
      feePct: 0.3,
      tokenA: emptyToken("WAX", "eosio.token", 8, 226_405.72),
      tokenB: emptyToken("WAXUSDT", "eth.token", 6, 1087.86),
      tvlUsd: 2139.28,
      volume24Usd: 319.27,
    },
  ];
}

export function sampleTrades(): LiveTrade[] {
  const now = Date.now();
  return [
    {
      poolId: 217,
      pair: "LEEF / WAX",
      time: new Date(now - 40_000).toISOString(),
      timestamp: now - 40_000,
      type: "buy",
      priceWax: 0.00002461,
      amountLeef: 1_250_000,
      amountPair: 30.82,
      pairSymbol: "WAX",
      txHash: "a8b3c1d94e2f000000000000",
      usdVolume: 0.19,
      account: "sample.wam",
    },
    {
      poolId: 1015,
      pair: "LEEF / WAX",
      time: new Date(now - 95_000).toISOString(),
      timestamp: now - 95_000,
      type: "sell",
      priceWax: 0.0000377,
      amountLeef: 420_000,
      amountPair: 15.71,
      pairSymbol: "WAX",
      txHash: "f4e2d1c07b9a000000000000",
      usdVolume: 0.09,
      account: "sample.wam",
    },
    {
      poolId: 217,
      pair: "LEEF / WAX",
      time: new Date(now - 160_000).toISOString(),
      timestamp: now - 160_000,
      type: "sell",
      priceWax: 0.00002458,
      amountLeef: 5_000_000,
      amountPair: 122.9,
      pairSymbol: "WAX",
      txHash: "7b9a2c113d2f000000000000",
      usdVolume: 0.75,
      account: "sample.wam",
    },
    {
      poolId: 1174,
      pair: "LEEF / USDT",
      time: new Date(now - 220_000).toISOString(),
      timestamp: now - 220_000,
      type: "buy",
      priceWax: 0.0000358,
      amountLeef: 800_000,
      amountPair: 0.17,
      pairSymbol: "USDT",
      txHash: "3d2f1e9ca8b3000000000000",
      usdVolume: 0.17,
      account: "sample.wam",
    },
  ];
}

/** Static priced universe for the offline book (last known values). */
export function fallbackUniverse(waxUsd = 0.00608, leefUsd = 1.496e-7): UniverseToken[] {
  const t = (
    symbol: string,
    contract: string,
    decimals: number,
    usdPrice: number,
    tvlUsd: number,
    poolId: number,
    stable = false,
  ): UniverseToken => ({
    symbol,
    contract,
    decimals,
    alcorId: `${symbol.toLowerCase()}-${contract}`,
    poolId,
    waxPerToken: waxUsd > 0 ? usdPrice / waxUsd : 0,
    usdPrice,
    tvlUsd,
    stable,
  });
  return [
    t("WAX", "eosio.token", 8, waxUsd, 5000, 217),
    t("LEEF", "leefmaincorp", 4, leefUsd, 1267, 217),
    t("USDT", "usdt.alcor", 4, 1, 1780, 1095, true),
    t("WAXUSDT", "eth.token", 6, 1, 2139, 32, true),
    t("WAXUSDC", "eth.token", 6, 1, 480, 8425, true),
    t("LSW", "lsw.alcor", 8, 0.00464, 301, 3273),
    t("TLM", "alien.worlds", 4, 0.00119, 67, 230),
    t("NBG", "newb.gm", 4, 0.000805, 40, 11502),
    t("BUZZ", "buzztoken.gm", 4, 0.00000064, 31, 6019),
    t("DUST", "niftywizards", 4, 0.0000105, 6, 220),
  ];
}

export function fallbackSnapshot(warning?: string, fetchedAt = "2026-01-01T00:00:00.000Z"): LeefSnapshot {
  const pools = fallbackPools();
  const aux = fallbackAux();
  const waxUsd = 0.00608;
  const main = pools.find((p) => p.id === 217);
  const waxPerLeef = main?.waxPerLeef ?? 0.00002461;
  const leefUsd = waxPerLeef * waxUsd;
  for (const p of pools) {
    if (p.usdPerLeef == null) p.usdPerLeef = (p.waxPerLeef ?? waxPerLeef) * waxUsd;
  }
  return {
    source: "fallback",
    fetchedAt,
    waxUsd,
    leefUsd,
    waxPerLeef,
    pools,
    aux,
    trades: sampleTrades(),
    universe: fallbackUniverse(waxUsd, leefUsd),
    warning:
      warning ??
      "Alcor API unreachable from this session. Showing the last known LEEF book.",
  };
}
