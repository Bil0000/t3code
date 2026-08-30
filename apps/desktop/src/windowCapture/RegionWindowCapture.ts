import type * as Electron from "electron";
import type { Result as ActiveWindow } from "get-windows";

export type RegionWindowCaptureSource = {
  readonly appIcon?: Electron.NativeImage;
  readonly name: string;
};

export async function captureRegionWindowSnapshot(
  active: ActiveWindow,
  region: Electron.Rectangle,
): Promise<{ readonly source: RegionWindowCaptureSource; readonly png: Buffer }> {
  const imported = await import("@crowecawcaw/xa11y");
  const xa11y = (imported as unknown as { readonly default?: typeof imported }).default ?? imported;
  const snapshot = await xa11y.screenshot({ region });
  return {
    source: {
      name: active.title.trim() || active.owner.name.trim() || "Window",
    },
    png: snapshot.toPng(),
  };
}
