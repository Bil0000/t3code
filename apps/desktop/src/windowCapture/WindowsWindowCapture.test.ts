import type * as Electron from "electron";
import type { Result as ActiveWindow } from "get-windows";
import { assert, it, vi } from "vite-plus/test";

const { screenToDipRectMock, screenshotMock } = vi.hoisted(() => ({
  screenToDipRectMock: vi.fn((_window: unknown, bounds: Electron.Rectangle) => bounds),
  screenshotMock: vi.fn(),
}));

vi.mock("electron", () => ({
  screen: { screenToDipRect: screenToDipRectMock },
}));

vi.mock("@crowecawcaw/xa11y", () => {
  const api = { screenshot: screenshotMock };
  return { ...api, default: api };
});

import { captureWindowsWindowSnapshot } from "./WindowsWindowCapture.ts";

it("captures the active Windows window without rendering Chromium thumbnails", async () => {
  const png = Buffer.from([1, 2, 3]);
  screenshotMock.mockResolvedValue({ toPng: () => png });
  const active = {
    title: "Editor",
    owner: { name: "Editor", processId: 123 },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as ActiveWindow;

  const capture = await captureWindowsWindowSnapshot(active);

  assert.deepEqual(screenToDipRectMock.mock.calls, [[null, active.bounds]]);
  assert.deepEqual(screenshotMock.mock.calls, [[{ region: active.bounds }]]);
  assert.strictEqual(capture.png, png);
  assert.deepEqual(capture.source, { name: "Editor" });
});
