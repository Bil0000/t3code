import type { WindowCaptureShortcut } from "@t3tools/contracts";

interface AccessibilityTreeNode {
  readonly name?: string;
  readonly value?: string;
  readonly children: ReadonlyArray<AccessibilityTreeNode>;
}

export function accessibleWindowText(root: AccessibilityTreeNode, maxChars: number): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const candidate of [node.name, node.value]) {
      const text = candidate?.replaceAll("\0", "").trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        lines.push(text);
      }
    }
    stack.push(...node.children.toReversed());
  }
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  const end = /[\uD800-\uDBFF]/.test(text[maxChars - 1] ?? "") ? maxChars - 1 : maxChars;
  return text.slice(0, end);
}

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

export function shouldRequestScreenCapturePermission(
  platform: NodeJS.Platform,
  previouslyEnabled: boolean,
  enabled: boolean,
): boolean {
  return platform === "darwin" && !previouslyEnabled && enabled;
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
