import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIMULATION_NODES,
  parseComputeResponse,
  simulatePackedTransaction,
  type SimulationFetcher,
} from "./simulate";

const TX = new Uint8Array([1, 2, 3, 255]);

describe("parseComputeResponse", () => {
  it("success carries CPU and elapsed", () => {
    expect(
      parseComputeResponse("https://n", { processed: { receipt: { cpu_usage_us: 812 }, elapsed: 900 } }),
    ).toEqual({ ok: true, node: "https://n", cpuUs: 812, elapsedUs: 900 });
  });

  it("a contract assert is surfaced without the boilerplate prefix", () => {
    const r = parseComputeResponse("https://n", {
      code: 500,
      error: {
        what: "Assertion failure",
        details: [{ message: "assertion failure with message: Received lower than minTokenOut: 30, poolId: 7801" }],
      },
    });
    expect(r).toEqual({
      ok: false,
      kind: "assert",
      node: "https://n",
      reason: "Received lower than minTokenOut: 30, poolId: 7801",
    });
  });

  it("garbage / empty answers are unusable (try the next node)", () => {
    expect(parseComputeResponse("https://n", null)).toBeNull();
    expect(parseComputeResponse("https://n", { hello: 1 })).toBeNull();
  });
});

describe("simulatePackedTransaction", () => {
  it("posts an UNSIGNED packed tx to compute_transaction on the default enforcing nodes", async () => {
    const fetcher = vi.fn<SimulationFetcher>(async () => ({ processed: { receipt: { cpu_usage_us: 300 } } }));
    const r = await simulatePackedTransaction(TX, { fetcher });
    expect(r.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, body] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${DEFAULT_SIMULATION_NODES[0]}/v1/chain/compute_transaction`);
    expect(JSON.parse(body)).toEqual({
      transaction: { signatures: [], compression: 0, packed_context_free_data: "", packed_trx: "010203ff" },
    });
  });

  it("fails over to the next node on network errors / unusable answers", async () => {
    const fetcher = vi
      .fn<SimulationFetcher>()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({ error: { what: "x", details: [{ message: "overdrawn balance" }] } });
    const r = await simulatePackedTransaction(TX, { fetcher, nodes: ["https://a", "https://b/"] });
    expect(r).toEqual({ ok: false, kind: "assert", node: "https://b/", reason: "overdrawn balance" });
    expect(fetcher.mock.calls[1]![0]).toBe("https://b/v1/chain/compute_transaction");
  });

  it("reports unreachable when no node answers", async () => {
    const fetcher = vi.fn<SimulationFetcher>(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await simulatePackedTransaction(TX, { fetcher, nodes: ["https://a"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("unreachable");
  });
});
