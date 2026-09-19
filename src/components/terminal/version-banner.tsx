import { useEffect, useRef, useState } from "react";

/**
 * Polls the build stamp (public/version.json, written by the prebuild
 * script) and shows a dismissible "new version available" banner when it
 * changes under a long-lived tab. Polls every 5 minutes with no-cache;
 * paused while the document is hidden (and re-checked on return).
 */

const POLL_MS = 5 * 60_000;
const VERSION_URL = "/version.json";

async function fetchVersion(): Promise<string | null> {
  try {
    const res = await fetch(VERSION_URL, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { v?: unknown };
    return typeof body.v === "string" && body.v ? body.v : null;
  } catch {
    return null;
  }
}

export function VersionBanner() {
  const [stale, setStale] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const baseline = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (stopped || document.hidden) return;
      const v = await fetchVersion();
      if (stopped || v == null) return;
      // First sighting only establishes the baseline — never banner on load.
      if (baseline.current === null) {
        baseline.current = v;
        return;
      }
      if (v !== baseline.current) setStale(true);
    };
    void check();
    const id = window.setInterval(check, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!stale || dismissed) return null;
  return (
    <div className="border-b border-warn/30 bg-warn/10">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-2 px-4 py-1.5 text-xs text-warn sm:px-6">
        <span>new version available — reload for the latest build</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded border border-warn/40 px-2 py-0.5 font-mono hover:bg-warn/20"
          >
            reload
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setDismissed(true)}
            className="px-1 text-warn/70 hover:text-warn"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}
