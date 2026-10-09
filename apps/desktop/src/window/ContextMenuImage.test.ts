import { beforeEach, expect, it, vi } from "vite-plus/test";
import type * as Electron from "electron";
import { copyContextMenuImage } from "./ContextMenuImage.ts";

const native = vi.hoisted(() => ({
  fetch: vi.fn(),
  createFromBuffer: vi.fn(),
  write: vi.fn(),
  image: { isEmpty: vi.fn(() => false), toPNG: vi.fn(() => Buffer.from("png")) },
}));

vi.mock("electron", () => ({
  net: { fetch: native.fetch },
  nativeImage: { createFromBuffer: native.createFromBuffer },
  clipboard: { write: native.write },
  ClipboardItem: class {
    readonly blobs: Record<string, Blob>;
    constructor(blobs: Record<string, Blob>) {
      this.blobs = blobs;
    }
  },
}));

const mainFrame = { isDestroyed: vi.fn(() => false) };
const frame = { isDestroyed: vi.fn(() => false) };
const contents = {
  isDestroyed: vi.fn(() => false),
  copyImageAt: vi.fn(),
  mainFrame,
};
const params = {
  x: 12,
  y: 34,
  srcURL: "https://example.com/image.png",
  frame,
};

const copyImage = (overrides: Partial<typeof params> = {}) =>
  copyContextMenuImage(
    contents as unknown as Electron.WebContents,
    { ...params, ...overrides } as unknown as Electron.ContextMenuParams,
  );

beforeEach(() => {
  vi.clearAllMocks();
  contents.isDestroyed.mockReturnValue(false);
  frame.isDestroyed.mockReturnValue(false);
  native.image.isEmpty.mockReturnValue(false);
  native.createFromBuffer.mockReturnValue(native.image);
  native.fetch.mockResolvedValue(new Response("image bytes"));
  native.write.mockResolvedValue(undefined);
});

it("preserves the clipboard when the context-menu frame is missing", async () => {
  await copyContextMenuImage(
    contents as unknown as Electron.WebContents,
    { ...params, frame: null } as unknown as Electron.ContextMenuParams,
  );
  expect(contents.copyImageAt).not.toHaveBeenCalled();
  expect(native.fetch).not.toHaveBeenCalled();
  expect(native.write).not.toHaveBeenCalled();
});

it("keeps native image copying for the main frame", async () => {
  await copyImage({ frame: mainFrame });
  expect(contents.copyImageAt).toHaveBeenCalledWith(12, 34);
  expect(native.fetch).not.toHaveBeenCalled();
});

it.each(["https://example.com/image.png", "data:image/png;base64,aW1hZ2UgYnl0ZXM="])(
  "copies an iframe image from %s",
  async (srcURL) => {
    await copyImage({ srcURL });
    if (srcURL.startsWith("https:")) {
      expect(native.fetch).toHaveBeenCalledWith(srcURL, {
        credentials: "omit",
        redirect: "error",
        signal: expect.any(AbortSignal),
      });
    } else {
      expect(native.fetch).not.toHaveBeenCalled();
    }
    expect(contents.copyImageAt).not.toHaveBeenCalled();
    expect(native.createFromBuffer).toHaveBeenCalledWith(Buffer.from("image bytes"));
    const blob = native.write.mock.calls[0]?.[0][0].blobs["image/png"] as Blob;
    expect(blob.type).toBe("image/png");
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(Buffer.from("png"));
  },
);

it.each([
  "file:///private/image.png",
  "blob:https://example.com/image",
  "https://user:pass@example.com/image.png",
])("rejects unsupported or credential-bearing URLs: %s", async (srcURL) => {
  await expect(copyImage({ srcURL })).rejects.toThrow("Unsupported image URL");
  expect(native.fetch).not.toHaveBeenCalled();
  expect(native.write).not.toHaveBeenCalled();
});

it("cancels responses whose declared size exceeds the limit", async () => {
  const cancel = vi.fn();
  native.fetch.mockResolvedValue(
    new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": String(32 * 1024 * 1024 + 1) },
    }),
  );
  await expect(copyImage()).rejects.toThrow("size limit");
  expect(cancel).toHaveBeenCalled();
  expect(native.createFromBuffer).not.toHaveBeenCalled();
});

it("cancels oversized streams without a content-length", async () => {
  const cancel = vi.fn();
  native.fetch.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(32 * 1024 * 1024));
          controller.enqueue(new Uint8Array(1));
        },
        cancel,
      }),
    ),
  );
  await expect(copyImage()).rejects.toThrow("size limit");
  expect(cancel).toHaveBeenCalled();
  expect(native.write).not.toHaveBeenCalled();
});

it("preserves the clipboard when the response is not an image", async () => {
  native.image.isEmpty.mockReturnValue(true);
  await expect(copyImage()).rejects.toThrow("could not be decoded");
  expect(native.write).not.toHaveBeenCalled();
});

it("does not copy after the source frame closes during the request", async () => {
  native.fetch.mockImplementation(() => {
    frame.isDestroyed.mockReturnValue(true);
    return Promise.resolve(new Response("image bytes"));
  });
  await copyImage();
  expect(native.write).not.toHaveBeenCalled();
});
