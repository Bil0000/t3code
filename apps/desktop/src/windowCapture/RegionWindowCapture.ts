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
  const capturedPng = snapshot.toPng();
  const scale = Math.min(maxSize.width / snapshot.width, maxSize.height / snapshot.height, 1);
  const png =
    scale < 1
      ? Electron.nativeImage
          .createFromBuffer(capturedPng)
          .resize({
            width: Math.max(1, Math.round(snapshot.width * scale)),
            height: Math.max(1, Math.round(snapshot.height * scale)),
            quality: "best",
          })
          .toPNG()
      : capturedPng;
  return {
    source: {
      name: active.title.trim() || active.owner.name.trim() || "Window",
    },
    png,
  };
}
