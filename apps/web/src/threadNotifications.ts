import type { ClientSettings } from "@t3tools/contracts/settings";

import completionUrl from "./assets/notification-completion.mp3";
import inputUrl from "./assets/notification-input.mp3";

type NotificationMode = ClientSettings["notificationMode"];
export const NOTIFICATION_MODE_LABELS = {
  off: "Off",
  notifications: "Notifications only",
  sound: "Sound only",
  "notifications-and-sound": "Notifications with sound",
} satisfies Record<NotificationMode, string>;

export function hasNotificationSound(mode: NotificationMode) {
  return mode === "sound" || mode === "notifications-and-sound";
}

export function hasDesktopNotifications(mode: NotificationMode) {
  return mode === "notifications" || mode === "notifications-and-sound";
}

let originalFavicon: HTMLLinkElement | undefined;
let badgeFavicon: HTMLLinkElement | undefined;
let faviconImage: Promise<HTMLImageElement> | undefined;
let faviconRevision = 0;

function drawNotificationBadge(context: CanvasRenderingContext2D, count: number) {
  context.fillStyle = "#e5484d";
  context.beginPath();
  context.arc(32, 32, 28, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "white";
  context.font = `600 ${count > 9 ? 30 : 40}px "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(count > 9 ? "9+" : String(count), 32, 34);
}

async function setFaviconBadge(count: number) {
  const revision = ++faviconRevision;
  if (count <= 0) {
    badgeFavicon?.remove();
    badgeFavicon = undefined;
    if (originalFavicon && !originalFavicon.isConnected) document.head.append(originalFavicon);
    originalFavicon = undefined;
    faviconImage = undefined;
    return;
  }
  originalFavicon ??= document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? undefined;
  if (!originalFavicon) return;
  if (!faviconImage) {
    const image = new Image();
    image.src = originalFavicon.href;
    faviconImage = image.decode().then(() => image);
  }
  try {
    const image = await faviconImage;
    if (revision !== faviconRevision) return;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) return;
    // Keep the favicon full-size; only overlay the counter in its top-right corner.
    context.drawImage(image, 0, 0, 64, 64);
    context.translate(32, 0);
    context.scale(0.5, 0.5);
    drawNotificationBadge(context, count);
    const href = canvas.toDataURL("image/png");
    if (!badgeFavicon) {
      badgeFavicon = document.createElement("link");
      badgeFavicon.rel = "icon";
      badgeFavicon.type = "image/png";
      badgeFavicon.sizes.value = "64x64";
      originalFavicon?.remove();
      document.head.append(badgeFavicon);
    }
    badgeFavicon.href = href;
  } catch {
    // Keep the original icon if its image cannot be loaded or drawn.
    if (revision === faviconRevision) faviconImage = undefined;
  }
}

export function setNotificationBadge(count: number) {
  const bridge = window.desktopBridge;
  if (!bridge) {
    void setFaviconBadge(count);
    return;
  }
  let image: string | null = null;
  if (count > 0 && bridge.getClientPlatform?.() === "win32") {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (context) {
      drawNotificationBadge(context, count);
      image = canvas.toDataURL("image/png");
    }
  }
  void bridge?.setNotificationBadge?.({ count, image }).catch(() => undefined);
}

let audioContext: AudioContext | undefined;
const buffers = new Map<string, Promise<AudioBuffer>>();

/** Called from a gesture so browsers allow later background playback. */
export function unlockNotificationAudio() {
  audioContext ??= new AudioContext();
  void audioContext.resume().catch(() => undefined);
}

export async function playNotificationSound(
  kind: "completion" | "input",
  shouldPlay: () => boolean,
) {
  if (!audioContext || audioContext.state !== "running") return;
  const context = audioContext;
  const url = kind === "completion" ? completionUrl : inputUrl;
  try {
    let buffer = buffers.get(url);
    if (!buffer) {
      buffer = fetch(url)
        .then((response) => response.arrayBuffer())
        .then((data) => context.decodeAudioData(data));
      buffers.set(url, buffer);
    }
    const decoded = await buffer;
    if (!shouldPlay() || context.state !== "running") return;
    const source = context.createBufferSource();
    source.buffer = decoded;
    source.connect(context.destination);
    source.start();
  } catch {
    buffers.delete(url);
  }
}
