import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettingsPatch,
  type DesktopWindowCaptureState,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const effects = vi.hoisted(() => [] as (() => void)[]);
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
    useEffect: (effect: () => void) => effects.push(effect),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
const bridge = vi.hoisted(() => ({
  getWindowCaptureState: vi.fn<() => Promise<DesktopWindowCaptureState>>(),
  setWindowCaptureShortcutSuppressed: vi.fn(),
  checkWindowCaptureShortcut: vi.fn(),
  previewWindowCaptureConfig: vi.fn(),
  applyWindowCaptureConfig: vi.fn(),
  onMenuAction: vi.fn(),
}));
vi.mock("../../lib/desktopWindowCapture", () => ({ getDesktopWindowCaptureBridge: () => bridge }));
const settingsStore = vi.hoisted(() => ({
  current: {} as typeof DEFAULT_CLIENT_SETTINGS,
  update: vi.fn<(patch: ClientSettingsPatch) => Promise<void>>(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => settingsStore.current,
  useUpdateClientSettings: () => settingsStore.update,
}));

import { WindowCaptureSettings } from "./WindowCaptureSettings";
import { WindowCaptureSetupDialog } from "./WindowCaptureSetupDialog";
import { CaptureShortcutConfig } from "./CaptureShortcutConfig";

let state: DesktopWindowCaptureState;
function render() {
  hooks.beginRender();
  return WindowCaptureSettings();
}
function wizard(tree: ReturnType<typeof render>) {
  return visitElements(tree, (element) => element.type === WindowCaptureSetupDialog);
}
function button(tree: ReturnType<typeof render>, label: string) {
  const node = visitElements(
    tree,
    (element) => element.props.children === label && typeof element.props.onClick === "function",
  );
  if (!node) throw new Error(`Missing button: ${label}`);
  return node.props as { onClick: () => void };
}
async function finish(promise: Promise<unknown>) {
  await promise;
  await Promise.resolve();
}
async function mount() {
  render();
  for (const effect of effects.splice(0)) effect();
  await finish(bridge.getWindowCaptureState.mock.results[0]!.value);
  return render();
}
beforeEach(() => {
  hooks.reset();
  effects.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal("navigator", { platform: "Linux" });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  settingsStore.current = { ...DEFAULT_CLIENT_SETTINGS, windowCaptureEnabled: true };
  state = {
    mode: "portal",
    linuxBackend: "hyprland",
    shortcut: DEFAULT_CLIENT_SETTINGS.windowCaptureShortcut,
    shortcutRegistered: false,
    shortcutActionRegistered: true,
    shortcutMessage: null,
    message: null,
    hyprlandHelper: { status: "ready", message: "Ready" },
  };
  bridge.getWindowCaptureState.mockImplementation(async () => state);
  bridge.setWindowCaptureShortcutSuppressed.mockResolvedValue(undefined);
  bridge.checkWindowCaptureShortcut.mockResolvedValue({ available: true, message: null });
  settingsStore.update.mockImplementation(async (patch) => {
    settingsStore.current = { ...settingsStore.current, ...patch };
    state = { ...state, shortcut: settingsStore.current.windowCaptureShortcut };
  });
});
afterEach(() => vi.unstubAllGlobals());

it.each(["niri", "hyprland"] as const)(
  "reopens %s setup at Shortcut without reading config or expanding Settings",
  async (desktop) => {
    state = { ...state, linuxBackend: desktop };
    const tree = await mount();
    expect(wizard(tree)).toBeNull();
    button(tree, "Change shortcut").onClick();
    await finish(bridge.getWindowCaptureState.mock.results[1]!.value);
    const opened = render();
    expect(visitElements(opened, (element) => element.type === CaptureShortcutConfig)).toBeNull();
    const dialog = wizard(opened);
    expect(dialog?.props.initialStep).toBe("shortcut");
    expect(bridge.previewWindowCaptureConfig).not.toHaveBeenCalled();
    expect(bridge.applyWindowCaptureConfig).not.toHaveBeenCalled();
    await (dialog!.props.onClose as (completed: boolean) => Promise<void>)(false);
    expect(wizard(render())).toBeNull();
    expect(settingsStore.update).not.toHaveBeenCalled();
    expect(settingsStore.current.windowCaptureEnabled).toBe(true);
  },
);
it("returns to Access if the Hyprland helper needs attention before changing keys", async () => {
  const tree = await mount();
  state = { ...state, hyprlandHelper: { status: "not-installed", message: "Install helper" } };
  button(tree, "Change shortcut").onClick();
  await finish(bridge.getWindowCaptureState.mock.results[1]!.value);
  expect(wizard(render())?.props.initialStep).toBe("access");
  expect(bridge.previewWindowCaptureConfig).not.toHaveBeenCalled();
});
it.each(["direct", "gnome-extension", "kde"] as const)(
  "keeps %s shortcut recording and saving inline",
  async (backend) => {
    state = {
      ...state,
      mode: backend === "direct" ? "direct" : "portal",
      linuxBackend: backend === "direct" ? undefined : backend,
      shortcutRegistered: true,
    };
    const tree = await mount();
    const recorder = (node: ReturnType<typeof render>) => {
      const control = visitElements(node, (element) => "data-keybinding-capture" in element.props);
      if (!control) throw new Error("Missing inline shortcut recorder");
      return control.props;
    };
    (recorder(tree).onClick as () => void)();
    await finish(bridge.setWindowCaptureShortcutSuppressed.mock.results.at(-1)!.value);
    (recorder(render()).onKeyDown as (event: object) => void)({
      key: "y",
      code: "KeyY",
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
      metaKey: false,
      repeat: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    await finish(bridge.checkWindowCaptureShortcut.mock.results[0]!.value);
    button(render(), "Save").onClick();
    await finish(settingsStore.update.mock.results[0]!.value);
    expect(settingsStore.update).toHaveBeenCalledWith({
      windowCaptureShortcut: expect.objectContaining({ key: "y", modKey: true, altKey: true }),
    });
    expect(wizard(render())).toBeNull();
    expect(bridge.previewWindowCaptureConfig).not.toHaveBeenCalled();
  },
);
