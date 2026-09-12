import { describe, expect, it } from "vitest";
import { marketEngine } from "./market-engine";
import { routeCache } from "./route-cache";
import { marketBus } from "./event-bus";

describe("MarketEngine (state surface — timers/network are unit-test-disabled)", () => {
  it("start() is idempotent: a second start never restarts anything", () => {
    marketEngine.start();
    const stateAfterFirst = marketEngine.getState();
    expect(stateAfterFirst.status).toBe("running");
    marketEngine.start(); // no-op
    expect(marketEngine.getState()).toBe(stateAfterFirst); // same object → no re-commit
  });

  it("exposes an immutable state snapshot for useSyncExternalStore", () => {
    const s1 = marketEngine.getState();
    const v1 = s1.version;
    marketEngine.reloadEndpoints(); // forces a commit without network
    const s2 = marketEngine.getState();
    expect(s2).not.toBe(s1);
    expect(s2.version).toBeGreaterThan(v1);
  });

  it("subscribers are notified on commits and can unsubscribe", () => {
    let calls = 0;
    const off = marketEngine.subscribe(() => {
      calls += 1;
    });
    marketEngine.reloadEndpoints();
    expect(calls).toBe(1);
    off();
    marketEngine.reloadEndpoints();
    expect(calls).toBe(1);
  });
});

describe("event bus wiring", () => {
  it("pool-change events reach listeners (routes invalidate per dependency)", () => {
    const seen: number[][] = [];
    const off = marketBus.on("pools", (p) => seen.push(p.changedIds));
    marketBus.emit("pools", { changedIds: [217], headBlock: 100 });
    expect(seen).toEqual([[217]]);
    off();
  });
});

describe("resume discipline (stale data never trades)", () => {
  it("invalidateAll drops every dependency version assumption", () => {
    // Simulate a long browser suspension: the engine calls this on wake.
    routeCache.invalidateAll();
    const stats = routeCache.stats();
    expect(stats.fresh).toBe(0);
  });
});
