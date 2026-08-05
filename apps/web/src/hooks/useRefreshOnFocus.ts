/**
 * Re-reading a host when the reader comes back to the window.
 *
 * A pull request changes while nobody is looking at it — a push lands, a check finishes, somebody
 * approves — and a page that only reads on mount shows yesterday's answer for as long as the tab
 * stays open. Coming back to the window is the moment the reader expects what they are looking at
 * to be true, and it costs nothing while they are away.
 */
import { useEffect, useRef } from "react";

/** Long enough that alt-tabbing through windows does not become a request per tab stop. */
export const REFRESH_ON_FOCUS_MIN_INTERVAL_MS = 10_000;

/**
 * Whether coming back to the window should read the host again. Separate from the hook because
 * the rule is the whole of it: only while the window is actually showing, and not again straight
 * away — a reader passing through three windows is not asking for three reads.
 */
export function shouldRefreshOnFocus(input: {
  readonly visible: boolean;
  readonly now: number;
  readonly lastRefreshedAt: number;
}): boolean {
  return input.visible && input.now - input.lastRefreshedAt >= REFRESH_ON_FOCUS_MIN_INTERVAL_MS;
}

export function useRefreshOnFocus(refresh: (() => void) | null, enabled = true): void {
  // Held in a ref so a caller can pass a fresh closure every render without re-arming the
  // listeners, which would otherwise refresh on every render that changed anything at all.
  const latest = useRef(refresh);
  latest.current = refresh;
  const lastRun = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      const now = Date.now();
      const visible = document.visibilityState === "visible";
      if (!shouldRefreshOnFocus({ visible, now, lastRefreshedAt: lastRun.current })) return;
      lastRun.current = now;
      latest.current?.();
    };
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", run);
    return () => {
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", run);
    };
  }, [enabled]);
}
