import * as NodeZlib from "node:zlib";
import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";

import { loadZipArchive } from "./zipPreview.ts";

const signal = () => new AbortController().signal;
const PNG_1X1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);

function pngHeader(width: number, height: number) {
  const bytes = PNG_1X1.slice();
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const archive = (files: Record<string, string | Uint8Array>) => {
  const zip = new JSZip();
  for (const [path, contents] of Object.entries(files)) zip.file(path, contents);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
};

function endOfDirectory(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { view, end: bytes.length - 22 };
}

function patchCentralEntries(bytes: Uint8Array, patch: (view: DataView, offset: number) => void) {
  const { view, end } = endOfDirectory(bytes);
  let offset = view.getUint32(end + 16, true);
  while (offset < end && view.getUint32(offset, true) === 0x02014b50) {
    patch(view, offset);
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
  return bytes;
}

const entry = (loaded: Awaited<ReturnType<typeof loadZipArchive>>, path: string) =>
  loaded.entries.find((candidate) => candidate.path === path)!;

describe("loadZipArchive", () => {
  it("lists folders and files and reads text, image and saved entries", async () => {
    const loaded = await loadZipArchive(
      await archive({
        "src/app.ts": "export const answer = 42;",
        "photos/a.png": PNG_1X1,
        "__MACOSX/._a.png": "metadata",
      }),
      signal(),
    );

    expect(loaded.entries.map(({ path, isDirectory }) => [path, isDirectory])).toEqual([
      ["photos/", true],
      ["photos/a.png", false],
      ["src/", true],
      ["src/app.ts", false],
    ]);
    expect(entry(loaded, "photos/a.png").mimeType).toBe("image/png");
    const text = await loaded.readTextPrefix(entry(loaded, "src/app.ts"), signal());
    expect(new TextDecoder().decode(text.bytes)).toBe("export const answer = 42;");
    expect(await loaded.readFile(entry(loaded, "photos/a.png"), signal())).toEqual(PNG_1X1);
    expect(
      new TextDecoder().decode(await loaded.readFileForSave(entry(loaded, "src/app.ts"), signal())),
    ).toBe("export const answer = 42;");
  });

  it.each([
    {
      name: "an archive above 32 MiB",
      bytes: async () => new Uint8Array(32 * 1024 * 1024 + 1),
      reason: "archive-limit",
    },
    {
      name: "more than 2,000 files",
      bytes: () =>
        archive(Object.fromEntries(Array.from({ length: 2001 }, (_, index) => [`${index}`, ""]))),
      reason: "entry-limit",
    },
    {
      name: "an encrypted entry",
      bytes: async () =>
        patchCentralEntries(await archive({ "secret.txt": "data" }), (view, offset) =>
          view.setUint16(offset + 8, view.getUint16(offset + 8, true) | 1, true),
        ),
      reason: "encrypted",
    },
    {
      name: "a ZIP64 directory",
      bytes: async () => {
        const bytes = await archive({ "a.txt": "data" });
        const { view, end } = endOfDirectory(bytes);
        view.setUint16(end + 8, 0xffff, true);
        view.setUint16(end + 10, 0xffff, true);
        return bytes;
      },
      reason: "unsupported",
    },
    {
      name: "a multipart archive",
      bytes: async () => {
        const bytes = await archive({ "a.txt": "data" });
        const { view, end } = endOfDirectory(bytes);
        view.setUint16(end + 4, 1, true);
        return bytes;
      },
      reason: "unsupported",
    },
    { name: "bytes that are not a ZIP", bytes: async () => new Uint8Array(64), reason: "invalid" },
  ])("refuses $name", async ({ bytes, reason }) => {
    await expect(loadZipArchive(await bytes(), signal())).rejects.toMatchObject({
      name: "ZipPreviewError",
      reason,
      message: expect.stringMatching(/ZIP/),
    });
  });

  it("refuses an entry whose checksum does not match its data", async () => {
    const bytes = patchCentralEntries(await archive({ "a.txt": "data" }), (view, offset) =>
      view.setUint32(offset + 16, view.getUint32(offset + 16, true) ^ 1, true),
    );
    const loaded = await loadZipArchive(bytes, signal());
    for (const read of [loaded.readFile, loaded.readTextPrefix, loaded.readFileForSave]) {
      await expect(read(entry(loaded, "a.txt"), signal())).rejects.toMatchObject({
        reason: "corrupt-entry",
      });
    }
  });

  it("refuses to preview an entry above 10 MiB or save one above 64 MiB from its header", async () => {
    const declared = (size: number) =>
      archive({ "a.log": "data" }).then((bytes) =>
        patchCentralEntries(bytes, (view, offset) => view.setUint32(offset + 24, size, true)),
      );
    const preview = await loadZipArchive(await declared(10 * 1024 * 1024 + 1), signal());
    await expect(preview.readFile(entry(preview, "a.log"), signal())).rejects.toMatchObject({
      reason: "file-limit",
      message: "File preview supports files up to 10 MiB.",
    });
    const save = await loadZipArchive(await declared(64 * 1024 * 1024 + 1), signal());
    await expect(save.readFileForSave(entry(save, "a.log"), signal())).rejects.toMatchObject({
      reason: "file-limit",
    });
  });

  it("stops a preview at 10 MiB of output when the header understates the entry size", async () => {
    const template = await archive({ "a.log": "data" });
    const templateView = new DataView(template.buffer, template.byteOffset, template.byteLength);
    const start = 30 + templateView.getUint16(26, true) + templateView.getUint16(28, true);
    const oldDirectory = templateView.getUint32(template.length - 6, true);
    const compressed = NodeZlib.deflateRawSync(new Uint8Array(10 * 1024 * 1024 + 1), { level: 1 });
    const directory = start + compressed.length;
    const bytes = new Uint8Array(directory + template.length - oldDirectory);
    bytes.set(template.subarray(0, start));
    bytes.set(compressed, start);
    bytes.set(template.subarray(oldDirectory), directory);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(18, compressed.length, true);
    view.setUint32(22, 1, true);
    view.setUint32(directory + 20, compressed.length, true);
    view.setUint32(directory + 24, 1, true);
    view.setUint32(bytes.length - 6, directory, true);

    const loaded = await loadZipArchive(bytes, signal());
    await expect(loaded.readFile(entry(loaded, "a.log"), signal())).rejects.toMatchObject({
      reason: "file-limit",
    });
  });

  it("refuses to preview an image above the pixel limit but still saves it", async () => {
    const huge = pngHeader(9000, 9000);
    const loaded = await loadZipArchive(await archive({ "huge.png": huge }), signal());
    await expect(loaded.readFile(entry(loaded, "huge.png"), signal())).rejects.toMatchObject({
      reason: "image-limit",
    });
    expect(await loaded.readFileForSave(entry(loaded, "huge.png"), signal())).toEqual(huge);
  });
});
