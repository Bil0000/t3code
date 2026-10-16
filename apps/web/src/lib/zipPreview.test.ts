import JSZip from "jszip";
import { describe, expect, it, vi } from "vite-plus/test";

import { loadZipPreview, readZipPreviewResponse } from "./zipPreview";

const signal = () => new AbortController().signal;

async function archive(zip: JSZip) {
  return new Blob([await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })]);
}

async function patchCentral(blob: Blob, patch: (view: DataView, offset: number) => void) {
  const bytes = await blob.arrayBuffer();
  const view = new DataView(bytes);
  for (let offset = 0; offset + 46 <= bytes.byteLength; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      patch(view, offset);
    }
  }
  return new Blob([bytes]);
}

describe("readZipPreviewResponse", () => {
  it("reads a streamed response into a ZIP blob", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]));
    const blob = await readZipPreviewResponse(response, signal());

    expect(blob.type).toBe("application/zip");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(response.body?.locked).toBe(false);
  });

  it("rejects failed responses and cancels their body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, { status: 500 });

    await expect(readZipPreviewResponse(response, signal())).rejects.toThrow(/could not load/i);
    expect(cancelled).toBe(true);
  });

  it("rejects responses without a body", async () => {
    await expect(readZipPreviewResponse(new Response(null), signal())).rejects.toThrow(
      /could not load/i,
    );
  });

  it("stops oversized downloads despite an incorrect Content-Length", async () => {
    let cancelled = false;
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array(chunk++ === 0 ? 32 * 1024 * 1024 : 1));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(body, { headers: { "Content-Length": "1" } });

    await expect(readZipPreviewResponse(response, signal())).rejects.toThrow(/32 MiB/i);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("cancels the body when the signal is already aborted", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      readZipPreviewResponse(new Response(body), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("cancels an active download while the next chunk is pending", async () => {
    let readingNext!: () => void;
    const nextChunk = new Promise<void>((resolve) => {
      readingNext = resolve;
    });
    let chunk = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (chunk++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
          else readingNext();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const downloading = readZipPreviewResponse(new Response(body), controller.signal);
    await nextChunk;
    controller.abort();

    await expect(downloading).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("releases the body after a download error", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("connection lost"));
      },
    });

    await expect(readZipPreviewResponse(new Response(body), signal())).rejects.toThrow(
      /connection lost/i,
    );
    expect(body.locked).toBe(false);
  });
});

describe("loadZipPreview", () => {
  it("lists implicit folders, empty folders, file names and uncompressed sizes", async () => {
    const zip = new JSZip();
    zip.file("photos/nested/PHOTO.PNG", new Uint8Array([1, 2, 3]), { createFolders: false });
    zip.file("readme.txt", "hello");
    zip.folder("empty");
    const preview = await loadZipPreview(await archive(zip), signal());

    expect(preview.entries).toEqual([
      { path: "empty/", name: "empty", isDirectory: true, sizeBytes: 0, mimeType: null },
      { path: "photos/", name: "photos", isDirectory: true, sizeBytes: 0, mimeType: null },
      { path: "photos/nested/", name: "nested", isDirectory: true, sizeBytes: 0, mimeType: null },
      {
        path: "photos/nested/PHOTO.PNG",
        name: "PHOTO.PNG",
        isDirectory: false,
        sizeBytes: 3,
        mimeType: "image/png",
      },
      { path: "readme.txt", name: "readme.txt", isDirectory: false, sizeBytes: 5, mimeType: null },
    ]);
  });

  it.each([true, false])(
    "allows 2,000 files without counting folders, createFolders=%s",
    async (createFolders) => {
      const zip = new JSZip();
      for (let index = 0; index < 2000; index++) {
        zip.file(`folder-${index}/file.txt`, "hello", { createFolders });
      }
      const preview = await loadZipPreview(await archive(zip), signal());

      expect(preview.entries.filter((entry) => !entry.isDirectory)).toHaveLength(2000);
      expect(preview.entries.filter((entry) => entry.isDirectory)).toHaveLength(2000);
    },
  );

  it("hides macOS metadata without hiding normal dotfiles", async () => {
    const zip = new JSZip()
      .file("__MACOSX/src/._app.ts", "metadata")
      .file("src/.DS_Store", "metadata")
      .file("src/._app.ts", "metadata")
      .file("src/app.ts", "export const app = true;")
      .file(".gitignore", "node_modules");
    const preview = await loadZipPreview(await archive(zip), signal());

    expect(preview.entries.map((entry) => entry.path)).toEqual([
      ".gitignore",
      "src/",
      "src/app.ts",
    ]);
  });

  it("reads the selected raster image into a typed blob", async () => {
    const zip = new JSZip().file("photo.jpg", new Uint8Array([0xff, 0xd8, 0xff]));
    const preview = await loadZipPreview(await archive(zip), signal());
    const image = await preview.readFile(preview.entries[0]!, signal());

    expect(image.type).toBe("image/jpeg");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
  });

  it.each(["photos\\image.png", "photos\\\\image.png", "photos//image.png"])(
    "keeps folder and file paths consistent for %s",
    async (path) => {
      const zip = new JSZip().file(path, new Uint8Array([1, 2, 3]), { createFolders: false });
      zip.file(path.slice(0, -"image.png".length), null, { dir: true, createFolders: false });
      const preview = await loadZipPreview(await archive(zip), signal());

      expect(preview.entries).toEqual([
        { path: "photos/", name: "photos", isDirectory: true, sizeBytes: 0, mimeType: null },
        {
          path: "photos/image.png",
          name: "image.png",
          isDirectory: false,
          sizeBytes: 3,
          mimeType: "image/png",
        },
      ]);
      const image = await preview.readFile(preview.entries[1]!, signal());
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    },
  );

  it("does not decompress files while listing the archive", async () => {
    const blob = await patchCentral(
      await archive(new JSZip().file("broken.png", "x")),
      (view, offset) => {
        view.setUint32(offset + 24, 2, true);
      },
    );
    const preview = await loadZipPreview(blob, signal());

    expect(preview.entries[0]?.sizeBytes).toBe(2);
    await expect(preview.readFile(preview.entries[0]!, signal())).rejects.toThrow(
      /could not read/i,
    );
  });

  it.each([
    ["src/app.ts", "export const value = 1;", "application/octet-stream"],
    ["app.log", "ready", "application/octet-stream"],
    ["README.md", "# Project", "application/octet-stream"],
    ["data.csv", "name,value\nexample,1", "application/octet-stream"],
    ["document.pdf", "%PDF-1.4", "application/pdf"],
    ["clip.mp4", "media", "video/mp4"],
    ["sound.mp3", "media", "audio/mpeg"],
    ["image.svg", "<svg/>", "image/svg+xml"],
  ])(
    "extracts only the selected file %s for the shared viewer",
    async (name, contents, mimeType) => {
      const preview = await loadZipPreview(
        await archive(new JSZip().file(name, contents)),
        signal(),
      );
      const entry = preview.entries.find((entry) => !entry.isDirectory)!;
      const file = await preview.readFile(entry, signal());

      expect(file.type).toBe(mimeType);
      expect(await file.text()).toBe(contents);
      const folder = preview.entries.find((entry) => entry.isDirectory);
      if (folder)
        await expect(preview.readFile(folder, signal())).rejects.toThrow(/not available/i);
    },
  );

  it("rejects corrupt archives with a clear error", async () => {
    await expect(loadZipPreview(new Blob(["not a zip"]), signal())).rejects.toThrow(
      /corrupt|valid ZIP/i,
    );
  });

  it("rejects encrypted archives", async () => {
    const blob = await patchCentral(
      await archive(new JSZip().file("photo.png", "x")),
      (view, offset) => {
        view.setUint16(offset + 8, 1, true);
      },
    );

    await expect(loadZipPreview(blob, signal())).rejects.toThrow(/encrypted/i);
  });

  it.each(["zip64", "multipart"])("rejects unsupported %s archive headers", async (kind) => {
    const bytes = await (await archive(new JSZip().file("a.txt", "x"))).arrayBuffer();
    const view = new DataView(bytes);
    const end = bytes.byteLength - 22;
    if (kind === "zip64") view.setUint16(end + 10, 0xffff, true);
    else view.setUint16(end + 4, 1, true);
    await expect(loadZipPreview(new Blob([bytes]), signal())).rejects.toThrow(
      kind === "zip64" ? /ZIP64/i : /multi-part/i,
    );
  });

  it("rejects unsupported compression", async () => {
    const blob = await patchCentral(
      await archive(new JSZip().file("photo.png", "x")),
      (view, offset) => {
        view.setUint16(offset + 10, 99, true);
      },
    );

    await expect(loadZipPreview(blob, signal())).rejects.toThrow(/compression.*not supported/i);
  });

  it("rejects archives above the compressed size limit", async () => {
    await expect(
      loadZipPreview(new Blob([new Uint8Array(32 * 1024 * 1024 + 1)]), signal()),
    ).rejects.toThrow(/32 MiB/i);
  });

  it("rejects too many entries even with a forged entry count", async () => {
    const zip = new JSZip();
    for (let index = 0; index < 2001; index++) {
      zip.file(`${index}.txt`, "");
    }
    const bytes = await (await archive(zip)).arrayBuffer();
    const view = new DataView(bytes);
    view.setUint16(bytes.byteLength - 22 + 8, 1, true);
    view.setUint16(bytes.byteLength - 22 + 10, 1, true);

    await expect(loadZipPreview(new Blob([bytes]), signal())).rejects.toThrow(/2,000 files/i);
  });

  it("bounds decoded file counts when directory attributes disagree", async () => {
    const zip = new JSZip();
    for (let index = 0; index < 2001; index++) zip.file(`${index}.txt`, "");
    let count = 0;
    const blob = await patchCentral(await archive(zip), (view, offset) => {
      if (count++ < 1000) view.setUint32(offset + 38, 0x40000000, true);
    });
    await expect(loadZipPreview(blob, signal())).rejects.toThrow(/2,000 files/i);
  });

  it("bounds implicit directories separately from files", async () => {
    const zip = new JSZip().file(`${"folder/".repeat(2001)}image.png`, "x", {
      createFolders: false,
    });

    await expect(loadZipPreview(await archive(zip), signal())).rejects.toThrow(/2,000 files/i);
  });

  it("lists oversized images but rejects image reads", async () => {
    const blob = await patchCentral(
      await archive(new JSZip().file("photo.png", "x")),
      (view, offset) => {
        view.setUint32(offset + 24, 10 * 1024 * 1024 + 1, true);
      },
    );
    const preview = await loadZipPreview(blob, signal());

    await expect(preview.readFile(preview.entries[0]!, signal())).rejects.toThrow(/10 MiB/i);
  });

  it("stops inflated image data at the limit even when the stored size is forged", async () => {
    const zip = new JSZip().file("photo.png", new Uint8Array(10 * 1024 * 1024 + 1));
    const blob = await patchCentral(await archive(zip), (view, offset) => {
      view.setUint32(offset + 24, 1, true);
    });
    const preview = await loadZipPreview(blob, signal());

    await expect(preview.readFile(preview.entries[0]!, signal())).rejects.toThrow(/10 MiB/i);
  });

  it("rejects a cancelled archive read", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(loadZipPreview(new Blob(), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("cancels an archive load while the blob read is pending", async () => {
    let resolveRead!: (bytes: ArrayBuffer) => void;
    const reading = new Promise<ArrayBuffer>((resolve) => {
      resolveRead = resolve;
    });
    const blob = new (class extends Blob {
      override arrayBuffer() {
        return reading;
      }
    })();
    const controller = new AbortController();
    const loading = loadZipPreview(blob, controller.signal);
    controller.abort();

    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    resolveRead(new ArrayBuffer(0));
  });

  it("cancels image reads before decompression starts", async () => {
    const preview = await loadZipPreview(
      await archive(new JSZip().file("photo.png", "x")),
      signal(),
    );
    const controller = new AbortController();
    const image = preview.readFile(preview.entries[0]!, controller.signal);
    controller.abort();

    await expect(image).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels image reads after the stream starts", async () => {
    const zip = new JSZip().file("photo.png", new Uint8Array(64 * 1024));
    const preview = await loadZipPreview(await archive(zip), signal());
    const controller = new AbortController();
    const prototype = Object.getPrototypeOf(zip.file("photo.png")) as {
      internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
    };
    const original = prototype.internalStream;
    const streaming = vi.spyOn(prototype, "internalStream").mockImplementation(function (
      this: typeof prototype,
      type,
    ) {
      return original.call(this, type).on("data", () => controller.abort());
    });
    try {
      await expect(preview.readFile(preview.entries[0]!, controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
    } finally {
      streaming.mockRestore();
    }

    expect((await preview.readFile(preview.entries[0]!, signal())).size).toBe(64 * 1024);
  });
});
