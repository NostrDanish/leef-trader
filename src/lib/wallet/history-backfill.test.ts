/**
 * Backfill shape tests — Hyperion rows → swap classification. Pure; the
 * network path is deliberately thin and untested here.
 */
import { describe, expect, it } from "vitest";
import { netTransfers, swapFromTransfers, type HyperionActionRow } from "./history-backfill";

const ME = "mywaxgallery";

function tr(contract: string, from: string, to: string, quantity: string): HyperionActionRow {
  return {
    trx_id: "tx1",
    timestamp: "2026-09-17T10:00:00.000Z",
    act: { account: contract, name: "transfer", data: { from, to, quantity, memo: "" } },
  };
}

describe("netTransfers", () => {
  it("nets per token and detects venue involvement", () => {
    const rows = [
      tr("eosio.token", ME, "swap.alcor", "10.00000000 WAX"),
      tr("leefmaincorp", "swap.alcor", ME, "99660.0000 LEEF"),
    ];
    const { nets, touchesVenue } = netTransfers(rows, ME);
    expect(touchesVenue).toBe(true);
    const wax = nets.find((n) => n.symbol === "WAX")!;
    expect(wax.sent).toBeCloseTo(10, 8);
    expect(wax.net).toBeCloseTo(-10, 8);
    const leef = nets.find((n) => n.symbol === "LEEF")!;
    expect(leef.received).toBeCloseTo(99660, 4);
  });

  it("ignores transfers that don't touch the account", () => {
    const rows = [tr("eosio.token", "someone", "swap.alcor", "5.00000000 WAX")];
    const { nets, touchesVenue } = netTransfers(rows, ME);
    expect(nets).toHaveLength(0);
    expect(touchesVenue).toBe(true); // venue seen, but not ours
  });
});

describe("swapFromTransfers", () => {
  it("classifies a plain swap", () => {
    const rows = [
      tr("eosio.token", ME, "swap.alcor", "10.00000000 WAX"),
      tr("leefmaincorp", "swap.alcor", ME, "99660.0000 LEEF"),
    ];
    const s = swapFromTransfers(rows, ME)!;
    expect(s.tokenIn).toBe("WAX");
    expect(s.tokenOut).toBe("LEEF");
    expect(s.amountIn).toBeCloseTo(10, 8);
    expect(s.amountOut).toBeCloseTo(99660, 4);
  });

  it("classifies a same-token round trip (arb/echo) by its gross legs", () => {
    const rows = [
      tr("eosio.token", ME, "swap.alcor", "10.00000000 WAX"),
      tr("leefmaincorp", "swap.alcor", ME, "9966.0000 LEEF"),
      tr("leefmaincorp", ME, "swap.alcor", "9966.0000 LEEF"),
      tr("eosio.token", "swap.alcor", ME, "10.20000000 WAX"),
    ];
    const s = swapFromTransfers(rows, ME)!;
    expect(s.tokenIn).toBe("WAX");
    expect(s.tokenOut).toBe("WAX");
    expect(s.amountIn).toBeCloseTo(10, 8);
    expect(s.amountOut).toBeCloseTo(10.2, 8);
  });

  it("rejects LP adds, plain transfers, and venue-free rows", () => {
    // LP add: two sends, no receive.
    const lpAdd = [
      tr("eosio.token", ME, "swap.alcor", "10.00000000 WAX"),
      tr("leefmaincorp", ME, "swap.alcor", "99660.0000 LEEF"),
    ];
    expect(swapFromTransfers(lpAdd, ME)).toBeNull();
    // Plain wallet transfer — no venue.
    const plain = [tr("eosio.token", ME, "friendaccount", "5.00000000 WAX")];
    expect(swapFromTransfers(plain, ME)).toBeNull();
    // Venue row but the account isn't involved.
    const notMine = [tr("eosio.token", "someone", "swap.alcor", "5.00000000 WAX")];
    expect(swapFromTransfers(notMine, ME)).toBeNull();
  });

  it("rejects multi-token shapes (LP removes, baskets)", () => {
    const lpRemove = [
      tr("eosio.token", "swap.alcor", ME, "10.00000000 WAX"),
      tr("leefmaincorp", "swap.alcor", ME, "99660.0000 LEEF"),
    ];
    expect(swapFromTransfers(lpRemove, ME)).toBeNull();
  });
});
