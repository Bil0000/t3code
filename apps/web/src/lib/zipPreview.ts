import JSZip from "jszip";

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ARCHIVE_LIMIT_ERROR = "ZIP preview supports archives up to 32 MiB.";
const ENTRY_LIMIT_ERROR = "ZIP preview supports up to 2,000 entries.";
const INVALID_ARCHIVE_ERROR =
  "Could not read this ZIP. The archive is corrupt or is not a valid ZIP file.";

export interface ZipPreviewEntry {
  readonly path: string;
  readonly name: string;
  readonly isDirectory: boolean;
  readonly sizeBytes: number;
  readonly mimeType: string | null;
}

type ZipFile = JSZip.JSZipObject & {
  readonly _data: { readonly uncompressedSize: number };
  internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array<ArrayBuffer>>;
};

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
};

function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function checkArchiveDirectory(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  let end = bytes.byteLength - 22;
  const start = Math.max(0, end - 65535);
  for (; end >= start; end--) {
    if (
      view.getUint32(end, true) === 0x06054b50 &&
      end + 22 + view.getUint16(end + 20, true) === bytes.byteLength
    ) {
      break;
    }
  }
  if (end < start) throw new Error(INVALID_ARCHIVE_ERROR);
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  if (
    count === 0xffff ||
    directorySize === 0xffffffff ||
    view.getUint32(end + 16, true) === 0xffffffff
  ) {
    throw new Error("ZIP64 archives are not supported in ZIP preview.");
  }
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) {
    throw new Error("Multi-part ZIP archives are not supported in ZIP preview.");
  }
  if (count > MAX_ENTRIES) throw new Error(ENTRY_LIMIT_ERROR);
  let offset = end - directorySize;
  let actualCount = 0;
  if (offset < 0) throw new Error(INVALID_ARCHIVE_ERROR);
  while (offset < end) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error(INVALID_ARCHIVE_ERROR);
    }
    if (++actualCount > MAX_ENTRIES) throw new Error(ENTRY_LIMIT_ERROR);
    if ((view.getUint16(offset + 8, true) & 1) !== 0) {
      throw new Error("Encrypted ZIP archives are not supported in ZIP preview.");
    }
    const compression = view.getUint16(offset + 10, true);
    if (compression !== 0 && compression !== 8) {
      throw new Error("This ZIP compression method is not supported in ZIP preview.");
    }
    if (view.getUint32(offset + 24, true) === 0xffffffff) {
      throw new Error("ZIP64 archives are not supported in ZIP preview.");
    }
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
  if (offset !== end || actualCount !== count) throw new Error(INVALID_ARCHIVE_ERROR);
}

function readImage(file: ZipFile, mimeType: string, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  const stream = file.internalStream("uint8array");
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      stream.pause();
      chunks.length = 0;
      signal.removeEventListener("abort", abort);
      reject(error);
    };
    const abort = () => fail(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    stream.on("data", (chunk) => {
      if (settled) return;
      size += chunk.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        fail(new Error("Image preview supports images up to 10 MiB."));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", () =>
      fail(new Error("Could not read this image from the ZIP. The image data is corrupt.")),
    );
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(new Blob(chunks, { type: mimeType }));
      chunks.length = 0;
    });
    queueMicrotask(() => {
      if (!settled) stream.resume();
    });
  });
}

export async function readZipPreviewResponse(
  response: Pick<Response, "ok" | "body">,
  signal: AbortSignal,
): Promise<Blob> {
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
    throw new Error("Could not load this ZIP file.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) return new Blob(chunks, { type: "application/zip" });
      size += value.byteLength;
      if (size > MAX_ARCHIVE_BYTES) throw new Error(ARCHIVE_LIMIT_ERROR);
      chunks.push(value as Uint8Array<ArrayBuffer>);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    chunks.length = 0;
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export async function loadZipPreview(blob: Blob, signal: AbortSignal) {
  signal.throwIfAborted();
  if (blob.size > MAX_ARCHIVE_BYTES) {
    throw new Error(ARCHIVE_LIMIT_ERROR);
  }
  const bytes = await withAbort(blob.arrayBuffer(), signal);
  checkArchiveDirectory(bytes);
  let zip: JSZip;
  try {
    zip = await withAbort(JSZip.loadAsync(bytes), signal);
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(INVALID_ARCHIVE_ERROR, { cause: error });
  }
  signal.throwIfAborted();
  const entries = new Map<string, ZipPreviewEntry>();
  const files = new Map<ZipPreviewEntry, ZipFile>();
  const addEntry = (path: string, isDirectory: boolean, sizeBytes = 0) => {
    const parts = path.split("/").filter(Boolean);
    const name = parts.at(-1) ?? path;
    const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
    const entry: ZipPreviewEntry = {
      path,
      name,
      isDirectory,
      sizeBytes,
      mimeType:
        !isDirectory && Object.hasOwn(IMAGE_MIME_TYPES, extension)
          ? IMAGE_MIME_TYPES[extension]!
          : null,
    };
    entries.set(path, entry);
    if (entries.size > MAX_ENTRIES) throw new Error(ENTRY_LIMIT_ERROR);
    return entry;
  };
  for (const object of Object.values(zip.files)) {
    const file = object as ZipFile;
    const parts = file.name.replaceAll("\\", "/").split("/").filter(Boolean);
    if (parts.length === 0) continue;
    const path = `${parts.join("/")}${file.dir ? "/" : ""}`;
    for (let index = 1; index < parts.length; index++) {
      const directory = `${parts.slice(0, index).join("/")}/`;
      if (!entries.has(directory)) addEntry(directory, true);
    }
    const entry = addEntry(path, file.dir, file.dir ? 0 : file._data.uncompressedSize >>> 0);
    if (!file.dir) files.set(entry, file);
  }
  const sortedEntries: readonly ZipPreviewEntry[] = [...entries.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return {
    entries: sortedEntries,
    async readImage(entry: ZipPreviewEntry, imageSignal: AbortSignal) {
      imageSignal.throwIfAborted();
      const file = files.get(entry);
      if (!file || !entry.mimeType)
        throw new Error("Image preview is not available for this file.");
      if (entry.sizeBytes > MAX_IMAGE_BYTES) {
        throw new Error("Image preview supports images up to 10 MiB.");
      }
      return readImage(file, entry.mimeType, imageSignal);
    },
  };
}
