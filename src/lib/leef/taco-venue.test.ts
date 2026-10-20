/**
 * TacoSwap venue: the swap.taco `pairs` table is keyed by a STRING pair code
 * ("AB", "TACTHC") with pool1/pool2 reserves — verified live 2026-10-20
 * (8280 rows). The numeric-sharded sweep never paged it and the `pools`
 * table is staking rewards, not swap pairs. These tests pin the key-ordered
 * sweep, the code-keyed parse, and fail-closed refresh.
 */
import { describe, expect, it, vi } from "vitest";

const { rpcPostMock } = vi.hoisted(() => ({ rpcPostMock: vi.fn() }));
vi.mock("@/lib/wallet/chain", () => ({ rpcPost: rpcPostMock }));

import {
  fetchTacoPools,
  parseTacoPairs,
  refreshVenuePair,
  tacoPairNativeId,
} from "./venue-adapters";
import { TACO_ID_BASE } from "./venues";

function tacoRow(code: string, waxQty = 1_000): Record<string, unknown> {
  return {
    id: code,
    supply: `1000000.0000 ${code}`,
    pool1: { quantity: `${waxQty.toFixed(8)} WAX`, contract: "eosio.token" },
    pool2: { quantity: "10000000.0000 LEEF", contract: "leefmaincorp" },
  };
}

describe("parseTacoPairs (string pair codes)", () => {
  it("parses the live row shape into code-keyed pools", () => {
    const pools = parseTacoPairs([tacoRow("AB")], 0.05);
    expect(pools).toHaveLength(1);
    const p = pools[0]!;
    expect(p.venue).toBe("taco");
    expect(p.pairCode).toBe("AB");
    expect(p.nativeId).toBe(tacoPairNativeId("AB"));
    expect(p.id).toBe(TACO_ID_BASE + tacoPairNativeId("AB"));
    expect(p.fee).toBe(3000);
    expect(p.tokenA.symbol).toBe("WAX");
    expect(p.tokenB.symbol).toBe("LEEF");
  });

  it("fails closed on numeric-id rows (old wrong-table shape)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pools = parseTacoPairs([{ ...tacoRow("AB"), id: 42 }], 0.05);
    expect(pools).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("dedupes a code the node returned twice", () => {
    const pools = parseTacoPairs([tacoRow("AB"), tacoRow("AB")], 0.05);
    expect(pools).toHaveLength(1);
  });

  it("skips drained pools and non-WAX dust books", () => {
    const drained = tacoRow("AB", 0);
    const dust = tacoRow("CD", 10); // below the 50-WAX dust floor, no TVL
    expect(parseTacoPairs([drained, dust], 0.05)).toEqual([]);
  });
});

describe("fetchTacoPools (key-ordered sweep)", () => {
  it("pages by next_key until more=false and never reads the pools table", async () => {
    const seenTables: string[] = [];
    const lowers: Array<string | number> = [];
    rpcPostMock.mockImplementation(async (_path: string, body: Record<string, unknown>) => {
      seenTables.push(String(body.table));
      lowers.push(body.lower_bound as string | number);
      if (body.lower_bound === 0 || body.lower_bound === undefined) {
        return { rows: [tacoRow("AB")], more: true, next_key: "16962" };
      }
      return { rows: [tacoRow("AC"), tacoRow("AB")], more: false };
    });
    const pools = await fetchTacoPools(0.05);
    expect(pools.map((p) => p.pairCode).sort()).toEqual(["AB", "AC"]);
    expect(lowers[0]).toBe(0);
    expect(lowers[1]).toBe("16962");
    expect(seenTables.every((t) => t === "pairs")).toBe(true);
  });

  it("fails closed to an empty venue on RPC errors", async () => {
    rpcPostMock.mockRejectedValue(new Error("node down"));
    await expect(fetchTacoPools(0.05)).resolves.toEqual([]);
  });
});

describe("refreshVenuePair (taco)", () => {
  it("fails closed without a discovered pair code", async () => {
    rpcPostMock.mockReset();
    await expect(refreshVenuePair("taco", 123, 0.05)).resolves.toBeNull();
    expect(rpcPostMock).not.toHaveBeenCalled();
  });

  it("re-reads the row by string code bounds and exact-matches the code", async () => {
    rpcPostMock.mockImplementation(async (_path: string, body: Record<string, unknown>) => {
      expect(body.table).toBe("pairs");
      expect(body.lower_bound).toBe("AB");
      expect(body.upper_bound).toBe("AB");
      return { rows: [tacoRow("AB")] };
    });
    const p = await refreshVenuePair("taco", tacoPairNativeId("AB"), 0.05, "AB");
    expect(p?.pairCode).toBe("AB");
  });

  it("refuses a neighboring row (exact code match only)", async () => {
    rpcPostMock.mockResolvedValue({ rows: [tacoRow("AC")] });
    await expect(
      refreshVenuePair("taco", tacoPairNativeId("AB"), 0.05, "AB"),
    ).resolves.toBeNull();
  });
});
