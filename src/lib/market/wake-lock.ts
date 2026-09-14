/**
 * Screen Wake Lock while the bot is live.
 *
 * Recovered from the old trader's BackgroundService: a sleeping screen
 * suspends the tab, timers throttle to 1/min, and a live bot silently
 * misses cycles. The market engine already resyncs correctly on wake —
 * this prevents the sleep in the first place while trading is active.
 *
 * Wake locks auto-release when the tab hides, so we re-request on every
 * return to visible while `wanted` is true. Unsupported / denied = no-op.
 */
type WakeLockSentinelLike = { release: () => Promise<void> };

let sentinel: WakeLockSentinelLike | null = null;
let wanted = false;
let listening = false;

function onVisibility(): void {
  if (document.visibilityState === "visible" && wanted) void acquire();
}

async function acquire(): Promise<void> {
  if (sentinel) return;
  try {
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
    };
    if (!nav.wakeLock) return;
    sentinel = await nav.wakeLock.request("screen");
  } catch {
    sentinel = null; // denied or unsupported — trading continues without it
  }
}

/** Idempotent. While held, the screen stays awake (visible tab only). */
export function holdWakeLock(): void {
  wanted = true;
  if (!listening && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
    listening = true;
  }
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    void acquire();
  }
}

export function releaseWakeLock(): void {
  wanted = false;
  const s = sentinel;
  sentinel = null;
  if (s) void s.release().catch(() => {});
  if (listening && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibility);
    listening = false;
  }
}

/** For tests/UI: whether a lock is currently held. */
export function wakeLockHeld(): boolean {
  return sentinel != null;
}
