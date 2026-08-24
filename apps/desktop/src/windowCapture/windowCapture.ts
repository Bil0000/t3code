import type { WindowCaptureShortcut } from "@t3tools/contracts";

const ELECTRON_KEY_NAMES: Readonly<Record<string, string>> = {
  " ": "Space",
  "+": "Plus",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  Escape: "Esc",
};

export function toElectronAccelerator(shortcut: WindowCaptureShortcut): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("CommandOrControl");
  if (shortcut.metaKey) parts.push("Command");
  if (shortcut.ctrlKey) parts.push("Control");
  if (shortcut.altKey) parts.push("Alt");
  if (shortcut.shiftKey) parts.push("Shift");
  parts.push(ELECTRON_KEY_NAMES[shortcut.key] ?? shortcut.key.toUpperCase());
  return parts.join("+");
}

interface CaptureSourceLike {
  readonly id: string;
  readonly name: string;
}

interface ActiveWindowLike {
  readonly id: number;
  readonly title: string;
}

export function findCaptureSource<T extends CaptureSourceLike>(
  sources: readonly T[],
  activeWindow: ActiveWindowLike,
): T | undefined {
  const idPrefix = `window:${activeWindow.id}:`;
  const idMatch = sources.find((source) => source.id.startsWith(idPrefix));
  if (idMatch) return idMatch;

  const title = activeWindow.title.trim();
  if (!title) return undefined;
  const titleMatches = sources.filter((source) => source.name.trim() === title);
  return titleMatches.length === 1 ? titleMatches[0] : undefined;
}

export function macWindowCaptureArguments(windowId: number, outputPath: string): string[] {
  return ["-l", String(windowId), "-o", "-x", "-t", "png", outputPath];
}

export function isWaylandSession(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): boolean {
  return (
    platform === "linux" &&
    (environment.XDG_SESSION_TYPE?.toLowerCase() === "wayland" ||
      Boolean(environment.WAYLAND_DISPLAY))
  );
}
