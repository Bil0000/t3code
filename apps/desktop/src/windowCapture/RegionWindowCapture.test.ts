import type { Result as ActiveWindow } from "get-windows";
import { assert, it, vi } from "vite-plus/test";

const { screenshotMock } = vi.hoisted(() => ({
  screenshotMock: vi.fn(),
}));

vi.mock("@crowecawcaw/xa11y", () => {
  const api = { screenshot: screenshotMock };
  return { ...api, default: api };
});

import { captureRegionWindowSnapshot } from "./RegionWindowCapture.ts";

it("captures a window region without rendering Chromium thumbnails", async () => {
  const png = Buffer.from([1, 2, 3]);
  screenshotMock.mockResolvedValue({ toPng: () => png });
  const active = {
    title: "Editor",
    owner: { name: "Editor", processId: 123 },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as ActiveWindow;
  const region = { x: 5, y: 10, width: 400, height: 300 };

  const capture = await captureRegionWindowSnapshot(active, region);

  assert.deepEqual(screenshotMock.mock.calls, [[{ region }]]);
  assert.strictEqual(capture.png, png);
  assert.deepEqual(capture.source, { name: "Editor" });
});
