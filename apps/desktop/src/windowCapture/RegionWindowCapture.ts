import * as Electron from "electron";
import type { Result as ActiveWindow } from "get-windows";

export type RegionWindowCaptureSource = {
  readonly appIcon?: Electron.NativeImage;
  readonly name: string;
};

export async function captureRegionWindowSnapshot(
  active: ActiveWindow,
  region: Electron.Rectangle,
  maxSize: Electron.Size,
): Promise<{ readonly source: RegionWindowCaptureSource; readonly png: Buffer }> {
  const imported = await import("@crowecawcaw/xa11y");
  const xa11y = (imported as unknown as { readonly default?: typeof imported }).default ?? imported;
  const snapshot = await xa11y.screenshot({ region });
  const { width, height } = snapshot;
  const scale = Math.min(maxSize.width / width, maxSize.height / height, 1);
  let png: Buffer;
  if (scale < 1) {
    // xa11y returns a copy of its RGBA pixels. Convert it in place to Windows'
    // opaque BGRA bitmap so resizing doesn't encode and decode a full-size PNG.
    const pixels = snapshot.pixels;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const red = pixels[offset]!;
      pixels[offset] = pixels[offset + 2]!;
      pixels[offset + 2] = red;
      pixels[offset + 3] = 255;
    }
    png = Electron.nativeImage
      .createFromBitmap(pixels, { width, height })
      .resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: "best",
      })
      .toPNG();
  } else {
    png = snapshot.toPng();
  }
  return {
    source: {
      name: active.title.trim() || active.owner.name.trim() || "Window",
    },
    png,
  };
}
