import * as Electron from "electron";

// Reads the icon a Windows top-level window advertises for itself, the same one
// Alt-Tab shows. Asking the one captured window costs well under a millisecond;
// desktopCapturer.getSources would enumerate every window on the desktop instead.

const WM_GETICON = 0x7f;
const ICON_SMALL = 0;
const ICON_BIG = 1;
const ICON_SMALL2 = 2;
const GCLP_HICON = -14;
const GCLP_HICONSM = -34;
const SMTO_BLOCK = 0x1;
const SMTO_ABORTIFHUNG = 0x2;
const GET_ICON_TIMEOUT_MS = 100;
const DIB_RGB_COLORS = 0;
const BITMAPINFOHEADER_SIZE = 40;

export interface WindowsWindowIconApi {
  readonly windowIcon: (windowHandle: bigint, kind: number) => bigint;
  readonly classIcon: (windowHandle: bigint, index: number) => bigint;
  readonly iconBitmaps: (
    icon: bigint,
  ) => { readonly color: bigint; readonly mask: bigint } | undefined;
  readonly bitmapSize: (
    bitmap: bigint,
  ) => { readonly width: number; readonly height: number } | undefined;
  readonly bitmapPixels: (bitmap: bigint, width: number, height: number) => Buffer | undefined;
  readonly deleteObject: (object: bigint) => void;
}

export interface WindowIconBitmap {
  readonly width: number;
  readonly height: number;
  readonly pixels: Buffer;
}

export function windowIconBitmapWithApi(
  windowHandle: bigint,
  api: WindowsWindowIconApi,
): WindowIconBitmap | undefined {
  const icon =
    api.windowIcon(windowHandle, ICON_BIG) ||
    api.windowIcon(windowHandle, ICON_SMALL2) ||
    api.windowIcon(windowHandle, ICON_SMALL) ||
    api.classIcon(windowHandle, GCLP_HICON) ||
    api.classIcon(windowHandle, GCLP_HICONSM);
  if (!icon) return undefined;
  const bitmaps = api.iconBitmaps(icon);
  if (!bitmaps) return undefined;
  try {
    // Monochrome icons keep their pixels in the mask alone; the file icon is a better fallback.
    if (!bitmaps.color) return undefined;
    const size = api.bitmapSize(bitmaps.color);
    if (!size || size.width <= 0 || size.height <= 0) return undefined;
    const color = api.bitmapPixels(bitmaps.color, size.width, size.height);
    if (!color) return undefined;
    const mask = bitmaps.mask ? api.bitmapPixels(bitmaps.mask, size.width, size.height) : undefined;
    const pixels = premultipliedIconPixels(color, mask);
    return pixels ? { ...size, pixels } : undefined;
  } finally {
    if (bitmaps.color) api.deleteObject(bitmaps.color);
    if (bitmaps.mask) api.deleteObject(bitmaps.mask);
  }
}

// GetDIBits returns straight-alpha BGRA, while nativeImage.createFromBitmap expects
// the premultiplied layout toBitmap produces. Icons drawn before alpha channels
// existed carry their transparency in the AND mask instead of the alpha byte.
export function premultipliedIconPixels(
  color: Buffer,
  mask: Buffer | undefined,
): Buffer | undefined {
  let hasAlpha = false;
  for (let offset = 3; offset < color.length; offset += 4) {
    if (color[offset] !== 0) {
      hasAlpha = true;
      break;
    }
  }
  if (hasAlpha) {
    for (let offset = 0; offset < color.length; offset += 4) {
      const alpha = color[offset + 3]!;
      if (alpha === 255) continue;
      color[offset] = Math.round((color[offset]! * alpha) / 255);
      color[offset + 1] = Math.round((color[offset + 1]! * alpha) / 255);
      color[offset + 2] = Math.round((color[offset + 2]! * alpha) / 255);
    }
    return color;
  }
  if (!mask || mask.length !== color.length) return undefined;
  for (let offset = 0; offset < color.length; offset += 4) {
    // The AND mask is black where the icon paints and white where it is transparent.
    if (mask[offset] === 0) {
      color[offset + 3] = 255;
    } else {
      color.fill(0, offset, offset + 4);
    }
  }
  return color;
}

let windowsWindowIconApiPromise: Promise<WindowsWindowIconApi> | undefined;

function loadWindowsWindowIconApi(): Promise<WindowsWindowIconApi> {
  windowsWindowIconApiPromise ??= import("ffi-rs").then(({ DataType, load, open }) => {
    const user32 = "t3-icon-user32";
    const gdi32 = "t3-icon-gdi32";
    open({ library: user32, path: "user32.dll" });
    open({ library: gdi32, path: "gdi32.dll" });

    return {
      windowIcon: (windowHandle, kind) => {
        const result = Buffer.alloc(8);
        const delivered = load({
          library: user32,
          funcName: "SendMessageTimeoutW",
          retType: DataType.BigInt,
          paramsType: [
            DataType.BigInt,
            DataType.U32,
            DataType.BigInt,
            DataType.BigInt,
            DataType.U32,
            DataType.U32,
            DataType.U8Array,
          ],
          paramsValue: [
            windowHandle,
            WM_GETICON,
            BigInt(kind),
            0n,
            SMTO_BLOCK | SMTO_ABORTIFHUNG,
            GET_ICON_TIMEOUT_MS,
            result,
          ],
        }) as bigint;
        return delivered ? result.readBigUInt64LE() : 0n;
      },
      classIcon: (windowHandle, index) =>
        load({
          library: user32,
          funcName: "GetClassLongPtrW",
          retType: DataType.BigInt,
          paramsType: [DataType.BigInt, DataType.I32],
          paramsValue: [windowHandle, index],
        }) as bigint,
      iconBitmaps: (icon) => {
        // ICONINFO: fIcon, xHotspot, yHotspot, padding, hbmMask, hbmColor.
        const info = Buffer.alloc(32);
        const found = load({
          library: user32,
          funcName: "GetIconInfo",
          retType: DataType.Boolean,
          paramsType: [DataType.BigInt, DataType.U8Array],
          paramsValue: [icon, info],
        });
        return found
          ? { mask: info.readBigUInt64LE(16), color: info.readBigUInt64LE(24) }
          : undefined;
      },
      bitmapSize: (bitmap) => {
        // BITMAP: bmType, bmWidth, bmHeight, bmWidthBytes, bmPlanes, bmBitsPixel, padding, bmBits.
        const info = Buffer.alloc(32);
        const written = load({
          library: gdi32,
          funcName: "GetObjectW",
          retType: DataType.I32,
          paramsType: [DataType.BigInt, DataType.I32, DataType.U8Array],
          paramsValue: [bitmap, info.byteLength, info],
        });
        return written > 0
          ? { width: info.readInt32LE(4), height: info.readInt32LE(8) }
          : undefined;
      },
      bitmapPixels: (bitmap, width, height) => {
        // BITMAPINFO: a BITMAPINFOHEADER followed by one RGBQUAD. A negative height
        // asks for top-down rows, which is the order createFromBitmap reads.
        const info = Buffer.alloc(BITMAPINFOHEADER_SIZE + 4);
        info.writeUInt32LE(BITMAPINFOHEADER_SIZE, 0);
        info.writeInt32LE(width, 4);
        info.writeInt32LE(-height, 8);
        info.writeUInt16LE(1, 12);
        info.writeUInt16LE(32, 14);
        const pixels = Buffer.alloc(width * height * 4);
        const deviceContext = load({
          library: user32,
          funcName: "GetDC",
          retType: DataType.BigInt,
          paramsType: [DataType.BigInt],
          paramsValue: [0n],
        }) as bigint;
        if (!deviceContext) return undefined;
        try {
          const lines = load({
            library: gdi32,
            funcName: "GetDIBits",
            retType: DataType.I32,
            paramsType: [
              DataType.BigInt,
              DataType.BigInt,
              DataType.U32,
              DataType.U32,
              DataType.U8Array,
              DataType.U8Array,
              DataType.U32,
            ],
            paramsValue: [deviceContext, bitmap, 0, height, pixels, info, DIB_RGB_COLORS],
          });
          return lines === height ? pixels : undefined;
        } finally {
          load({
            library: user32,
            funcName: "ReleaseDC",
            retType: DataType.I32,
            paramsType: [DataType.BigInt, DataType.BigInt],
            paramsValue: [0n, deviceContext],
          });
        }
      },
      deleteObject: (object) => {
        load({
          library: gdi32,
          funcName: "DeleteObject",
          retType: DataType.Boolean,
          paramsType: [DataType.BigInt],
          paramsValue: [object],
        });
      },
    } satisfies WindowsWindowIconApi;
  });
  return windowsWindowIconApiPromise;
}

export async function windowsWindowIcon(
  windowHandle: number,
): Promise<Electron.NativeImage | undefined> {
  const bitmap = windowIconBitmapWithApi(BigInt(windowHandle), await loadWindowsWindowIconApi());
  if (!bitmap) return undefined;
  const image = Electron.nativeImage.createFromBitmap(bitmap.pixels, {
    width: bitmap.width,
    height: bitmap.height,
  });
  return image.isEmpty() ? undefined : image;
}
