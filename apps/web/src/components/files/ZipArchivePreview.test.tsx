// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ZipPreviewEntry } from "~/lib/zipPreview";

import ZipArchivePreview from "./ZipArchivePreview";

const entries: ZipPreviewEntry[] = [
  { path: "photos/", name: "photos", isDirectory: true, sizeBytes: 0, mimeType: null },
  { path: "photos/a.png", name: "a.png", isDirectory: false, sizeBytes: 3, mimeType: "image/png" },
];

vi.mock("~/lib/zipPreview", () => ({
  loadZipPreview: async () => ({
    entries,
    readImage: async (entry: ZipPreviewEntry) => new Blob([entry.name], { type: "image/png" }),
  }),
  readZipPreviewResponse: vi.fn(),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/components/chat/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("./fileSurfaceChrome", () => ({
  FileSurfaceFailure: ({ message }: { message: string }) => <div role="alert">{message}</div>,
  FileSurfaceLoading: () => <div role="status">Loading</div>,
}));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => children,
}));

let root: Root;
let container: HTMLDivElement;
let intersect: (isIntersecting: boolean) => void;
const revoked: string[] = [];

const flush = () => act(async () => {});
const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === label || element.textContent?.startsWith(label),
  )!;
const press = (key: string) =>
  act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let next = 0;
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => `blob:${next++}`,
    revokeObjectURL: (url: string) => revoked.push(url),
  });
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        intersect = (isIntersecting) => callback([{ isIntersecting }]);
      }
      observe() {}
      disconnect() {}
    },
  );
  revoked.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root.render(
      <ZipArchivePreview name="photos.zip" file={new Blob()} url="blob:zip" onRetry={() => {}} />,
    ),
  );
  await flush();
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ZipArchivePreview", () => {
  it("releases thumbnails that leave the viewport and reloads them on return", async () => {
    await act(() => button("photos").click());
    await act(() => intersect(true));
    await flush();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:0");

    await act(() => intersect(false));
    expect(container.querySelector("img")).toBeNull();
    expect(revoked).toEqual(["blob:0"]);

    await act(() => intersect(true));
    await flush();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:1");
  });

  it("keeps keyboard back navigation after the clicked tile unmounts", async () => {
    await act(() => button("photos").click());
    await act(() => intersect(true));
    await flush();
    await act(() => button("Open a.png").click());
    await flush();
    expect(container.querySelector("img[alt='a.png']")).not.toBeNull();

    await press("Escape");
    expect(container.querySelector("img[alt='a.png']")).toBeNull();
    expect(button("Open a.png")).toBeDefined();

    await press("Backspace");
    expect(button("photos")).toBeDefined();
    expect(container.querySelector("[aria-current='page']")?.textContent).toBe("photos.zip");
  });
});
