import * as Electron from "electron";
import type { Result as ActiveWindow } from "get-windows";

export type WindowsWindowCaptureSource = {
  readonly appIcon?: Electron.NativeImage;
  readonly name: string;
};

export async function captureWindowsWindowSnapshot(
  active: ActiveWindow,
): Promise<{ readonly source: WindowsWindowCaptureSource; readonly png: Buffer }> {
  const imported = await import("@crowecawcaw/xa11y");
  const xa11y = (imported as unknown as { readonly default?: typeof imported }).default ?? imported;
  const snapshot = await xa11y.screenshot({
    region: Electron.screen.screenToDipRect(null, active.bounds),
  });
  return {
    source: {
      name: active.title.trim() || active.owner.name.trim() || "Window",
    },
    png: snapshot.toPng(),
  };
}
