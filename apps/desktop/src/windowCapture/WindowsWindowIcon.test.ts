import { assert, describe, it } from "vite-plus/test";
import {
  premultipliedIconPixels,
  windowIconBitmapWithApi,
  type WindowsWindowIconApi,
} from "./WindowsWindowIcon.ts";

describe("premultipliedIconPixels", () => {
  it("premultiplies straight-alpha icons in place", () => {
    const color = Buffer.from([200, 100, 50, 128, 10, 20, 30, 255, 90, 90, 90, 0]);

    assert.strictEqual(premultipliedIconPixels(color, undefined), color);
    assert.deepEqual([...color], [100, 50, 25, 128, 10, 20, 30, 255, 0, 0, 0, 0]);
  });

  it("derives alpha from the AND mask when the color plane has none", () => {
    const color = Buffer.from([200, 100, 50, 0, 10, 20, 30, 0]);
    const mask = Buffer.from([0, 0, 0, 0, 255, 255, 255, 0]);

    assert.deepEqual([...premultipliedIconPixels(color, mask)!], [200, 100, 50, 255, 0, 0, 0, 0]);
  });

  it("gives up on alpha-less icons without a usable mask", () => {
    assert.isUndefined(premultipliedIconPixels(Buffer.from([1, 2, 3, 0]), undefined));
    assert.isUndefined(premultipliedIconPixels(Buffer.from([1, 2, 3, 0]), Buffer.alloc(8)));
  });
});

describe("windowIconBitmapWithApi", () => {
  function fakeApi(overrides: Partial<WindowsWindowIconApi> = {}) {
    const deleted: Array<bigint> = [];
    const api: WindowsWindowIconApi = {
      windowIcon: () => 0n,
      classIcon: (_, index) => (index === -14 ? 7n : 0n),
      iconBitmaps: (icon) => (icon === 7n ? { color: 70n, mask: 71n } : undefined),
      bitmapSize: () => ({ width: 1, height: 1 }),
      bitmapPixels: (bitmap) =>
        bitmap === 70n ? Buffer.from([1, 2, 3, 255]) : Buffer.from([0, 0, 0, 0]),
      deleteObject: (object) => {
        deleted.push(object);
      },
      ...overrides,
    };
    return { api, deleted };
  }

  it("falls back to the class icon and releases both GDI bitmaps", () => {
    const { api, deleted } = fakeApi();

    const bitmap = windowIconBitmapWithApi(42n, api);

    assert.deepEqual(bitmap, { width: 1, height: 1, pixels: Buffer.from([1, 2, 3, 255]) });
    assert.deepEqual(deleted, [70n, 71n]);
  });

  it("returns nothing for windows without an icon", () => {
    const { api } = fakeApi({ classIcon: () => 0n });

    assert.isUndefined(windowIconBitmapWithApi(42n, api));
  });

  it("skips monochrome icons but still releases their mask", () => {
    const { api, deleted } = fakeApi({ iconBitmaps: () => ({ color: 0n, mask: 71n }) });

    assert.isUndefined(windowIconBitmapWithApi(42n, api));
    assert.deepEqual(deleted, [71n]);
  });
});
