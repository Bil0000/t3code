import type { Result as ActiveWindow } from "get-windows";
import { assert, it, vi } from "vite-plus/test";

const { createFromBufferMock, resizeMock, screenshotMock } = vi.hoisted(() => ({
  createFromBufferMock: vi.fn(),
  resizeMock: vi.fn(),
  screenshotMock: vi.fn(),
}));

vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: createFromBufferMock },
}));

vi.mock("@crowecawcaw/xa11y", () => {
  const api = { screenshot: screenshotMock };
  return { ...api, default: api };
});

import { captureRegionWindowSnapshot } from "./RegionWindowCapture.ts";

it("captures a window region without rendering Chromium thumbnails", async () => {
  const png = Buffer.from([1, 2, 3]);
  screenshotMock.mockResolvedValue({ width: 400, height: 300, toPng: () => png });
  const active = {
    title: "Editor",
    owner: { name: "Editor", processId: 123 },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as ActiveWindow;
  const region = { x: 5, y: 10, width: 400, height: 300 };

  const capture = await captureRegionWindowSnapshot(active, region, region);

  assert.deepEqual(screenshotMock.mock.calls, [[{ region }]]);
  assert.strictEqual(capture.png, png);
  assert.deepEqual(capture.source, { name: "Editor" });
});

it("bounds large native captures before they are persisted", async () => {
  const png = Buffer.from([1, 2, 3]);
  const resizedPng = Buffer.from([4, 5, 6]);
  screenshotMock.mockResolvedValue({ width: 6_000, height: 4_000, toPng: () => png });
  resizeMock.mockReturnValue({ toPNG: () => resizedPng });
  createFromBufferMock.mockReturnValue({ resize: resizeMock });
  const active = {
    title: "Editor",
    owner: { name: "Editor", processId: 123 },
    bounds: { x: 0, y: 0, width: 6_000, height: 4_000 },
  } as ActiveWindow;

  const capture = await captureRegionWindowSnapshot(active, active.bounds, {
    width: 2_560,
    height: 1_600,
  });

  assert.deepEqual(resizeMock.mock.calls, [[{ width: 2_400, height: 1_600, quality: "best" }]]);
  assert.strictEqual(capture.png, resizedPng);
});
