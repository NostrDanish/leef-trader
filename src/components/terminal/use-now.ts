import { useSyncExternalStore } from "react";

/**
 * Shared ticking clock for "xs ago" freshness displays.
 *
 * `Date.now()` must not be called during render (react-hooks/purity). This
 * module owns one interval per resolution and exposes the current time via
 * useSyncExternalStore, so renders stay pure and all freshness labels tick
 * from a single timer.
 */

const clocks = new Map<
  number,
  { now: number; timer: number | null; listeners: Set<() => void> }
>();

function clock(resolutionMs: number) {
  let c = clocks.get(resolutionMs);
  if (!c) {
    c = { now: Date.now(), timer: null, listeners: new Set() };
    clocks.set(resolutionMs, c);
  }
  return c;
}

function subscribe(resolutionMs: number, cb: () => void) {
  const c = clock(resolutionMs);
  c.listeners.add(cb);
  if (c.timer == null) {
    c.timer = window.setInterval(() => {
      c.now = Date.now();
      for (const l of c.listeners) l();
    }, resolutionMs);
  }
  return () => {
    c.listeners.delete(cb);
    if (c.listeners.size === 0 && c.timer != null) {
      window.clearInterval(c.timer);
      c.timer = null;
    }
  };
}

/** Current time in ms, re-rendering at most every `resolutionMs` (default 1s). */
export function useNow(resolutionMs = 1000): number {
  return useSyncExternalStore(
    (cb) => subscribe(resolutionMs, cb),
    () => clock(resolutionMs).now,
    () => clock(resolutionMs).now,
  );
}

/** Pure relative-time label ("just now" / "42s ago" / "3m ago" / "2h ago"). */
export function relTime(isoOrMs: string | number, now: number): string {
  const t = typeof isoOrMs === "number" ? isoOrMs : new Date(isoOrMs).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
