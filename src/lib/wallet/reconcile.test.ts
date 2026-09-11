import { describe, expect, it } from "vitest";
import { assetDelta, parseHyperionTransfers } from "./reconcile";
import { waxResourceBlock } from "./chain";

const ACCOUNT = "trader.leef";

/** A realistic Hyperion get_transaction body for WAX→LEEF via swap.alcor. */
const SWAP_TX = {
  trx_id: "aa11",
  executed: true,
  block_num: 287_364_200,
  actions: [
    {
      act: {
        account: "eosio.token",
        name: "transfer",
        data: {
          from: ACCOUNT,
          to: "swap.alcor",
          quantity: "10.00000000 WAX",
          memo: "swapexactin#1159#trader.leef#240000.0000 LEEF@leefmaincorp#0",
        },
      },
    },
    {
      act: {
        account: "leefmaincorp",
        name: "transfer",
        data: {
          from: "swap.alcor",
          to: ACCOUNT,
          quantity: "241234.5678 LEEF",
          memo: "swap fill",
        },
      },
    },
    {
      // Non-transfer action — must be ignored.
      act: { account: "swap.alcor", name: "logswap", data: { pool: 1159 } },
    },
    {
      // A transfer between foreign accounts in the same tx (notifications /
      // inline noise) — must not affect OUR deltas.
      act: {
        account: "eosio.token",
        name: "transfer",
        data: { from: "market.maker", to: "swap.alcor", quantity: "3.00000000 WAX", memo: "" },
      },
    },
  ],
};

describe("parseHyperionTransfers", () => {
  it("extracts token transfers from an indexed transaction", () => {
    const parsed = parseHyperionTransfers(SWAP_TX);
    expect(parsed).not.toBeNull();
    expect(parsed!.executed).toBe(true);
    expect(parsed!.transfers).toHaveLength(3);
    expect(parsed!.transfers[0]).toMatchObject({
      contract: "eosio.token",
      from: ACCOUNT,
      to: "swap.alcor",
      amount: 10,
      symbol: "WAX",
    });
  });

  it("returns null for not-yet-indexed or malformed responses", () => {
    expect(parseHyperionTransfers(null)).toBeNull();
    expect(parseHyperionTransfers({})).toBeNull();
    expect(parseHyperionTransfers({ actions: [] })).toBeNull();
    expect(parseHyperionTransfers({ trx_id: "x", error: "not found" })).toBeNull();
    expect(parseHyperionTransfers("garbage")).toBeNull();
  });

  it("marks failed transactions", () => {
    const parsed = parseHyperionTransfers({ ...SWAP_TX, executed: false });
    expect(parsed!.executed).toBe(false);
  });
});

describe("assetDelta", () => {
  const transfers = parseHyperionTransfers(SWAP_TX)!.transfers;

  it("computes net deltas from the account's perspective", () => {
    expect(assetDelta(transfers, ACCOUNT, "WAX", "eosio.token")).toBeCloseTo(-10, 8);
    expect(assetDelta(transfers, ACCOUNT, "LEEF", "leefmaincorp")).toBeCloseTo(241234.5678, 4);
  });

  it("ignores other accounts' transfers", () => {
    // The foreign 3 WAX transfer must not leak into our delta.
    expect(assetDelta(transfers, ACCOUNT, "WAX")).toBeCloseTo(-10, 8);
  });

  it("scopes by contract when given one (spoofed-symbol safety)", () => {
    const spoofed = [
      ...transfers,
      {
        contract: "fake.leef",
        from: "swap.alcor",
        to: ACCOUNT,
        quantity: "9999.0000 LEEF",
        amount: 9999,
        symbol: "LEEF",
        memo: "",
      },
    ];
    expect(assetDelta(spoofed, ACCOUNT, "LEEF", "leefmaincorp")).toBeCloseTo(241234.5678, 4);
    expect(assetDelta(spoofed, ACCOUNT, "LEEF")).toBeCloseTo(241234.5678 + 9999, 4);
  });
});

describe("waxResourceBlock", () => {
  it("passes a healthy account", () => {
    expect(waxResourceBlock(0.4, 0.5, 0.6)).toBeNull();
    expect(waxResourceBlock(null, null, null)).toBeNull(); // unknown = chain decides
  });

  it("blocks on exhausted CPU / NET / RAM", () => {
    expect(waxResourceBlock(0.96, null, null)).toMatch(/CPU/);
    expect(waxResourceBlock(null, 0.99, null)).toMatch(/NET/);
    expect(waxResourceBlock(null, null, 0.99)).toMatch(/RAM/);
  });

  it("does not block near-but-under thresholds", () => {
    expect(waxResourceBlock(0.95, 0.98, 0.98)).toBeNull();
  });
});
