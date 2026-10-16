// @vitest-environment jsdom

import {
  EnvironmentId,
  IssueTrackerKind,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type DeviceServiceState,
  type IssueTrackerConnectionList,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { listBrowserImportSources, trackerState } = vi.hoisted(() => ({
  trackerState: {
    environmentId: null as string | null,
    phase: "connected",
    scopeListeners: new Set<() => void>(),
    canEdit: true,
    data: null as IssueTrackerConnectionList | null,
    connect: vi.fn(),
    connections: vi.fn(),
  },
  listBrowserImportSources: vi.fn().mockResolvedValue([]),
}));

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactNode; children: ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: () => null,
}));
vi.mock("../preview/previewBridge", () => ({
  previewBridge: { listBrowserImportSources },
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [], isReady: true }),
  usePrimaryEnvironment: () => null,
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE: "Connect to an environment",
  useClientSettings: (selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
  useClientSettingsHydrated: () => true,
  usePrimarySettingsAvailable: () => true,
  usePrimarySettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdatePrimarySettings: () => vi.fn(),
}));
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ProjectDefaultsSettings", () => ({ ProjectDefaultsSettings: () => null }));
vi.mock("../../state/issueTrackers", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    issueTrackerEnvironment: {
      connections: trackerState.connections,
      connect: { permissionAtom: () => Atom.make(trackerState.canEdit), label: "test-connect" },
      bindProject: { permissionAtom: () => Atom.make(trackerState.canEdit) },
      scopes: () => null,
    },
  };
});
vi.mock("../../state/query", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../state/query")>();
  return {
    ...original,
    useEnvironmentQuery: (query: Parameters<typeof original.useEnvironmentQuery>[0]) =>
      trackerState.connections.mock.results.some((result) => result.value === query)
        ? { data: trackerState.data, isPending: false, error: null }
        : original.useEnvironmentQuery(query),
  };
});
vi.mock("../../state/use-atom-command", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../state/use-atom-command")>();
  return {
    useAtomCommand: (...args: Parameters<typeof original.useAtomCommand>) => {
      const command = original.useAtomCommand(...args);
      return args[0].label === "test-connect" ? trackerState.connect : command;
    },
  };
});
vi.mock("./SettingsScopeContext", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useSettingsScope: () => {
      useSyncExternalStore(
        (listener) => {
          trackerState.scopeListeners.add(listener);
          return () => {
            trackerState.scopeListeners.delete(listener);
          };
        },
        () => JSON.stringify([trackerState.environmentId, trackerState.phase]),
      );
      return {
        scope: { kind: "all", environmentIds: [] },
        search: {},
        environment:
          trackerState.environmentId === null
            ? null
            : {
                environmentId: trackerState.environmentId,
                connection: { phase: trackerState.phase },
              },
        environments: [],
        target: null,
        connectedEnvironments: [],
        targets: [],
      };
    },
    useOptionalSettingsScope: () => null,
  };
});

import { IntegrationsSettingsPanel } from "./IntegrationsSettings";
import { deviceHubReadiness, platformSetupStatus } from "../device/DeviceSetup";

let renderer: ReactTestRenderer | undefined;
let domRoot: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listBrowserImportSources.mockClear();
  trackerState.environmentId = null;
  trackerState.phase = "connected";
  trackerState.canEdit = true;
  trackerState.data = null;
  trackerState.connections.mockReset().mockReturnValue(trackerState.connections);
  trackerState.connect.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  await act(() => domRoot?.unmount());
  domRoot = undefined;
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
});

async function openSettings() {
  const router = createRouter({
    routeTree: createRootRoute({ component: IntegrationsSettingsPanel }),
    history: createMemoryHistory(),
  });
  await router.load();
  await act(() => {
    renderer = create(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );
  });
  expect(renderer!.root.findByType(IntegrationsSettingsPanel)).toBeDefined();
}

describe("Integrations browser discovery", () => {
  it("does not scan browser files when entering or revisiting settings", async () => {
    await openSettings();
    expect(listBrowserImportSources).not.toHaveBeenCalled();

    await act(() => renderer?.unmount());
    await openSettings();
    expect(listBrowserImportSources).not.toHaveBeenCalled();
  });

  it("places device settings directly after browser settings", async () => {
    await openSettings();
    const sections = renderer!.root
      .findAll((node) => node.type === "section")
      .map((node) => node.props.id)
      .filter(Boolean);
    expect(sections.indexOf("devices")).toBeGreaterThan(sections.indexOf("browser"));
  });
});

async function openIntegrationsDom() {
  const router = createRouter({
    routeTree: createRootRoute({ component: IntegrationsSettingsPanel }),
    history: createMemoryHistory(),
  });
  await router.load();
  if (container === undefined) {
    container = document.createElement("div");
    document.body.append(container);
    domRoot = createRoot(container);
  }
  await act(async () => {
    trackerState.scopeListeners.forEach((listener) => listener());
    domRoot!.render(<RouterProvider router={router} />);
  });
}

describe("Integrations issue tracker setup", () => {
  it.each(["linear", "jira"] as const)("connects %s in the selected environment", async (kind) => {
    const tracker = IssueTrackerKind.make(kind);
    const displayName = kind === "linear" ? "Linear" : "Jira";
    trackerState.environmentId = "remote";
    trackerState.data = {
      trackers: [
        {
          tracker,
          displayName,
          host: null,
          scopeNoun: "project",
          credential: { label: "API key", helpUrl: null },
          connected: false,
          account: null,
          detail: null,
          scopes: [],
        },
      ],
      accounts: [],
      projectBindings: {},
      bindings: {},
    };
    await openIntegrationsDom();
    const section = container!.querySelector<HTMLElement>("#issue-trackers");
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain(displayName);
    expect([...container!.querySelectorAll("section")].indexOf(section!)).toBeLessThan(
      [...container!.querySelectorAll("section")].findIndex((item) => item.id === "browser"),
    );
    const credential = section!.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(credential).not.toBeNull();
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        credential,
        "fake-test-key",
      );
      credential.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      section!
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(trackerState.connect).toHaveBeenCalledExactlyOnceWith({
      environmentId: EnvironmentId.make("remote"),
      input: { tracker, token: { value: "fake-test-key" } },
    });
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        credential,
        "fake-unsaved-draft",
      );
      credential.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(credential.value).toBe("fake-unsaved-draft");
    trackerState.environmentId = "local";
    trackerState.canEdit = false;
    await openIntegrationsDom();
    expect(trackerState.connections).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: {},
    });
    const localSection = container!.querySelector("#issue-trackers")!;
    expect(localSection.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
    expect(localSection.querySelector("fieldset")!.disabled).toBe(true);
    await act(async () => {
      localSection
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(trackerState.connect).toHaveBeenCalledTimes(1);
  });

  it.each([null, "disconnected"])(
    "does not load tracker setup for an unavailable environment (%s)",
    async (phase) => {
      trackerState.environmentId = phase === null ? null : "remote";
      trackerState.phase = phase ?? "connected";
      await openIntegrationsDom();
      expect(trackerState.connections).not.toHaveBeenCalled();
      expect(container!.querySelector("#issue-trackers")).toBeNull();
    },
  );
});

const deviceState = (overrides: Partial<DeviceServiceState> = {}): DeviceServiceState => ({
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "This machine",
      hubInstalled: false,
      agentDeviceInstalled: false,
      platforms: [
        { platform: "ios", available: true },
        { platform: "android", available: true },
      ],
    },
  ],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "/api/device-hub",
  revision: 0,
  ...overrides,
});

describe("device setup guidance", () => {
  it("directs users to install an iOS runtime and create an Android virtual device", () => {
    expect(platformSetupStatus(deviceState(), "ios").message).toContain("Xcode Settings");
    expect(platformSetupStatus(deviceState(), "android").message).toContain("Device Manager");
  });

  it("preserves a specific missing-tool explanation from the server", () => {
    const state = deviceState({
      hosts: [
        {
          ...deviceState().hosts[0]!,
          platforms: [
            { platform: "ios", available: true },
            { platform: "android", available: false, reason: "Android Emulator is missing." },
          ],
        },
      ],
    });
    expect(platformSetupStatus(state, "android").message).toBe("Android Emulator is missing.");
  });

  it("counts a remote device host when this machine has no simulator tooling", () => {
    const state = deviceState({
      hostStatus: "idle",
      hostStatuses: { macmini: { status: "ready" } },
      hosts: [
        {
          ...deviceState().hosts[0]!,
          platforms: [
            { platform: "ios", available: false, reason: "Xcode was not found." },
            { platform: "android", available: false, reason: "Android SDK was not found." },
          ],
        },
        {
          id: "macmini",
          kind: "ssh",
          label: "Mac Mini",
          hubInstalled: true,
          agentDeviceInstalled: true,
          platforms: [
            { platform: "ios", available: true },
            { platform: "android", available: false, reason: "Android SDK was not found." },
          ],
        },
      ],
      devices: [
        {
          hostId: "macmini",
          id: "iphone",
          platform: "ios",
          name: "iPhone 16 Pro",
          version: "iOS 27.0",
          booted: true,
          physical: false,
        },
      ],
    });
    expect(deviceHubReadiness(state).ready).toBe(true);
    expect(platformSetupStatus(state, "ios")).toEqual({
      ready: true,
      message: "Xcode and iOS Simulator are available on Mac Mini.",
    });
    expect(platformSetupStatus(state, "android").ready).toBe(false);
  });
});
