import * as Electron from "electron";
import { sourceDimensions } from "../preview/FaviconCapture.ts";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export async function copyContextMenuImage(
  contents: Electron.WebContents,
  params: Electron.ContextMenuParams,
): Promise<void> {
  const frame = params.frame;
  if (contents.isDestroyed() || !frame || frame.isDestroyed()) return;
  if (frame === contents.mainFrame) {
    contents.copyImageAt(params.x, params.y);
    return;
  }

  const url = new URL(params.srcURL);
  if (
    !["https:", "http:", "data:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.protocol === "data:" && params.srcURL.length > MAX_IMAGE_BYTES * 3)
  ) {
    throw new Error("Unsupported image URL");
  }
  const fetchImage = url.protocol === "data:" ? globalThis.fetch : Electron.net.fetch;
  const response = await fetchImage(url.href, {
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new Error("Image request failed or exceeded the size limit");
  }
  if (!response.body) throw new Error("Image response has no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("Image exceeded the size limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks, byteLength);
  const dimensions = sourceDimensions(bytes);
  if (
    !dimensions ||
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    dimensions.width * dimensions.height > MAX_IMAGE_BYTES / 4
  ) {
    throw new Error("Image dimensions exceed the size limit");
  }
  const image = Electron.nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error("Image could not be decoded");
  if (contents.isDestroyed() || frame.isDestroyed()) return;
  const png = image.toPNG();
  if (png.byteLength > MAX_IMAGE_BYTES) throw new Error("PNG exceeded the size limit");
  await Electron.clipboard.write([
    new Electron.ClipboardItem({
      "image/png": new Blob([Uint8Array.from(png)], { type: "image/png" }),
    }),
  ]);
}
