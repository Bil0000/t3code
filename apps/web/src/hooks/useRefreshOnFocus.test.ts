import { describe, expect, it } from "vite-plus/test";

import { REFRESH_ON_FOCUS_MIN_INTERVAL_MS, shouldRefreshOnFocus } from "./useRefreshOnFocus";

describe("shouldRefreshOnFocus", () => {
  const at = (now: number, lastRefreshedAt: number, visible = true) =>
    shouldRefreshOnFocus({ visible, now, lastRefreshedAt });

  it("reads again when the window comes back after a while away", () => {
    expect(at(REFRESH_ON_FOCUS_MIN_INTERVAL_MS, 0)).toBe(true);
  });

  it("does not read again for every window tabbed through", () => {
    expect(at(1_000, 0)).toBe(false);
  });

  it("stays quiet while the window is not showing", () => {
    // A focus event can arrive for a window that is still hidden behind another one.
    expect(at(REFRESH_ON_FOCUS_MIN_INTERVAL_MS * 5, 0, false)).toBe(false);
  });
});
