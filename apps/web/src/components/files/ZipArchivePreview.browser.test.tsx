import { act, render, type Screen } from "../../../test/render";
import "../../index.css";

import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import type { ZipPreviewEntry } from "~/lib/zipPreview";

import ZipArchivePreview from "./ZipArchivePreview";

const { load, readFile, refresh } = vi.hoisted(() => ({
  load: vi.fn(),
  readFile: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("~/lib/zipPreview", () => ({
  loadZipPreview: load,
  readZipPreviewResponse: vi.fn(),
}));
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: () => refresh,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector
      ? selector(DEFAULT_CLIENT_SETTINGS)
      : DEFAULT_CLIENT_SETTINGS) as typeof import("~/hooks/useSettings").useClientSettings,
}));
vi.mock("~/components/ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <article>{text}</article>,
}));
vi.mock("./ReadOnlySourcePreview", () => ({
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));

const entry = (path: string): ZipPreviewEntry => ({
  path,
  name: path.split("/").at(-1)!,
  isDirectory: path.endsWith("/"),
  sizeBytes: 3,
  mimeType: null,
});

function setup(entries = [entry("photos/a.png"), entry("src/app.ts")]) {
  load.mockReset().mockResolvedValue({ entries, readFile });
  readFile.mockReset().mockImplementation(async (entry: ZipPreviewEntry) => new Blob([entry.name]));
  refresh.mockReset();
}

async function open() {
  const container = document.createElement("div");
  container.style.cssText = "display: flex; width: 900px; height: 480px;";
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <ZipArchivePreview name="project.zip" file={new Blob()} url="blob:zip" onRetry={() => {}} />,
      { container },
    ),
  );
  await vi.waitFor(() => expect(rows(screen).length).toBeGreaterThan(0));
  const environment = stack.move();
  return { ...screen, [Symbol.asyncDispose]: () => environment.disposeAsync() };
}

function rows(screen: Screen) {
  return [
    ...(screen.container
      .querySelector("file-tree-container")
      ?.shadowRoot?.querySelectorAll<HTMLElement>("[data-item-path]") ?? []),
  ];
}

async function select(screen: Screen, path: string) {
  await vi.waitFor(() =>
    expect(
      rows(screen).some((row) => row.dataset.itemPath === path),
      path,
    ).toBe(true),
  );
  const row = rows(screen).find((row) => row.dataset.itemPath === path)!;
  await act(() => row.click());
}

async function back(screen: Screen) {
  await userEvent.click(screen.getByRole("button", { name: "Back to ZIP files" }));
  await vi.waitFor(() => expect(screen.container.querySelector("pre, article, img")).toBeNull());
}

describe("ZIP file browsing", () => {
  it("virtualizes 2,000 images without extracting or decoding while browsing and searching", async () => {
    setup(Array.from({ length: 2000 }, (_, index) => entry(`photos/image-${index}.png`)));
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      ),
      (character) => character.charCodeAt(0),
    );
    readFile.mockResolvedValue(new Blob([png], { type: "image/png" }));
    using createUrl = vi.spyOn(URL, "createObjectURL");
    await using screen = await open();
    expect(screen.container.textContent).toContain("2,000 files");
    expect(rows(screen).length).toBeLessThan(2000);
    await userEvent.fill(screen.getByRole("searchbox", { name: "Search ZIP files" }), "image-1999");
    await vi.waitFor(() =>
      expect(rows(screen).map((row) => row.dataset.itemPath)).toContain("photos/image-1999.png"),
    );
    expect(readFile).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
    expect(screen.container.querySelector("img")).toBeNull();

    await select(screen, "photos/image-1999.png");
    await expect.element(screen.getByRole("img", { name: "image-1999.png" })).toBeVisible();
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["src/app.ts", "export const answer = 42;", "pre"],
    ["logs/app.log", "server ready", "pre"],
    ["README.md", "# ZIP project", "article"],
  ] as const)(
    "opens %s with the shared text viewer and can reopen it",
    async (path, contents, tag) => {
      setup([entry(path)]);
      readFile.mockResolvedValue(new Blob([contents]));
      using createUrl = vi.spyOn(URL, "createObjectURL");
      using revokeUrl = vi.spyOn(URL, "revokeObjectURL");
      await using screen = await open();
      await select(screen, path);
      await vi.waitFor(() =>
        expect(screen.container.querySelector(tag)?.textContent).toBe(contents),
      );
      await expect.element(screen.getByRole("button", { name: "Copy contents" })).toBeVisible();
      if (tag === "article") {
        await userEvent.click(screen.getByRole("button", { name: "Show markdown source" }));
        await vi.waitFor(() =>
          expect(screen.container.querySelector("pre")?.textContent).toBe(contents),
        );
      }
      const url = createUrl.mock.results[0]!.value;
      await back(screen);
      expect(revokeUrl).toHaveBeenCalledWith(url);
      await select(screen, path);
      await vi.waitFor(() =>
        expect(screen.container.querySelector(tag)?.textContent).toBe(contents),
      );
      await screen.unmount();
      expect(revokeUrl).toHaveBeenCalledWith(createUrl.mock.results[1]!.value);
    },
  );

  it("shows CSV as a table and can switch to shared source view", async () => {
    setup([entry("data.csv")]);
    readFile.mockResolvedValue(new Blob(["name,value\nexample,42"]));
    await using screen = await open();
    await select(screen, "data.csv");
    await vi.waitFor(() =>
      expect([...screen.container.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual([
        "name",
        "value",
      ]),
    );
    expect([...screen.container.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual([
      "example",
      "42",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Show source" }));
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("name,value\nexample,42"),
    );
  });

  it("aborts stale extraction and releases the selected file on return", async () => {
    setup();
    let finish!: (file: Blob) => void;
    let pendingSignal!: AbortSignal;
    readFile.mockImplementationOnce((_entry: ZipPreviewEntry, signal: AbortSignal) => {
      pendingSignal = signal;
      return new Promise<Blob>((resolve) => {
        finish = resolve;
      });
    });
    using createUrl = vi.spyOn(URL, "createObjectURL");
    using revokeUrl = vi.spyOn(URL, "revokeObjectURL");
    await using screen = await open();
    await select(screen, "photos/a.png");
    await select(screen, "src/app.ts");
    expect(pendingSignal.aborted).toBe(true);
    await act(() => finish(new Blob(["stale image"])));
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("app.ts"),
    );
    expect(screen.container.querySelector("img")).toBeNull();
    expect(createUrl).toHaveBeenCalledTimes(1);
    await back(screen);
    expect(revokeUrl).toHaveBeenCalledWith(createUrl.mock.results[0]!.value);
  });

  it.each(["Escape", "Backspace"])(
    "returns to the tree with %s without consuming text input",
    async (key) => {
      setup();
      using createUrl = vi.spyOn(URL, "createObjectURL");
      using revokeUrl = vi.spyOn(URL, "revokeObjectURL");
      await using screen = await open();
      await select(screen, "src/app.ts");
      await vi.waitFor(() =>
        expect(screen.container.querySelector("pre")?.textContent).toBe("app.ts"),
      );
      const input = screen.container.querySelector<HTMLInputElement>('input[type="search"]')!;
      input.focus();
      const editable = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(() => input.dispatchEvent(editable));
      expect(editable.defaultPrevented).toBe(false);
      expect(screen.container.querySelector("pre")?.textContent).toBe("app.ts");

      const root = screen.container.querySelector<HTMLElement>('[tabindex="-1"]')!;
      root.focus();
      const navigation = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(() => root.dispatchEvent(navigation));
      expect(navigation.defaultPrevented).toBe(true);
      expect(screen.container.querySelector("pre")).toBeNull();
      expect(revokeUrl).toHaveBeenCalledWith(createUrl.mock.results[0]!.value);
      await select(screen, "src/app.ts");
      await vi.waitFor(() =>
        expect(screen.container.querySelector("pre")?.textContent).toBe("app.ts"),
      );
    },
  );

  it("keeps same-name files and folders accessible without tree path collisions", async () => {
    setup([
      entry("same"),
      entry("same/"),
      entry("same/app.ts"),
      entry("same (file)"),
      entry("same (file)/"),
      entry("same (file)/nested.txt"),
    ]);
    await using screen = await open();
    for (const [path, name] of [
      ["same (file) (file)", "same"],
      ["same (file) (file) (file)", "same (file)"],
    ] as const) {
      await select(screen, path);
      await expect
        .element(screen.getByText("No preview for this file", { exact: true }))
        .toBeVisible();
      expect(readFile).toHaveBeenLastCalledWith(
        expect.objectContaining({ path: name }),
        expect.any(AbortSignal),
      );
      await back(screen);
    }
    await select(screen, "same/app.ts");
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("app.ts"),
    );
    await back(screen);
    await select(screen, "same (file)/nested.txt");
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("nested.txt"),
    );
  });

  it.each([
    "File preview supports files up to 10 MiB.",
    "Image preview supports up to 16 million pixels and 8,192 pixels per side. Download the ZIP to open it.",
    "Cannot safely preview this image. Download the ZIP to open it.",
  ])("shows %s without decoding or losing the file tree", async (message) => {
    setup();
    readFile.mockRejectedValueOnce(new Error(message));
    using createUrl = vi.spyOn(URL, "createObjectURL");
    await using screen = await open();
    await select(screen, "photos/a.png");
    await expect.element(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.container.querySelector("img")).toBeNull();
    expect(createUrl).not.toHaveBeenCalled();
    await back(screen);
    await select(screen, "src/app.ts");
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("app.ts"),
    );
  });
});
