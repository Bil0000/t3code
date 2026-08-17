import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const connectionState = vi.hoisted(() => ({
  data: {
    status: "authenticated" as "authenticated" | "unauthenticated",
    hasStoredToken: true,
    accountName: "Ada" as string | null,
    accountEmail: "ada@example.com" as string | null,
    teams: [] as ReadonlyArray<{ id: string; key: string; name: string }>,
  },
  error: "Linear status failed" as string | null,
}));
const commands = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  settings: vi.fn(),
}));
const settingsState = vi.hoisted(() => ({
  projectTeams: {} as Record<string, string>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (settings: unknown) => unknown) =>
    select({ issueTracking: { linear: { projectTeams: settingsState.projectTeams } } }),
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "primary" }),
}));

vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/issueTracking", () => ({
  issueTrackingEnvironment: {
    linearStatus: vi.fn(),
    linearConnect: "connect",
    linearDisconnect: "disconnect",
  },
}));
vi.mock("../../state/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/query")>();
  return {
    ...actual,
    useEnvironmentQuery: () => ({
      data: connectionState.data,
      error: connectionState.error,
      isPending: false,
      refresh: vi.fn(),
    }),
  };
});
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: "settings" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof commands) => commands[command],
}));
import { Input } from "../ui/input";
import { DialogPopup } from "../ui/dialog";
import { LinearConnectionDialog } from "./LinearConnectionDialog";

describe("Linear connection dialog", () => {
  beforeEach(() => {
    hooks.reset();
    vi.clearAllMocks();
    connectionState.data = {
      status: "authenticated",
      hasStoredToken: true,
      accountName: "Ada",
      accountEmail: "ada@example.com",
      teams: [],
    };
    connectionState.error = "Linear status failed";
    settingsState.projectTeams = {};
  });

  it("keeps connection management and errors inside one dialog", () => {
    hooks.beginRender();
    const dialog = LinearConnectionDialog({
      open: true,
      onOpenChange: vi.fn(),
      onProviderChanged: vi.fn(),
    });

    expect(visitElements(dialog, (element) => element.type === DialogPopup)).not.toBeNull();
    expect(
      visitElements(
        dialog,
        (element) =>
          element.type === Input && element.props["aria-label"] === "Replace Linear API key",
      ),
    ).not.toBeNull();
    expect(visitElements(dialog, (element) => element.props.role === "alert")?.props.children).toBe(
      "Linear status failed",
    );
    expect(
      visitElements(dialog, (element) => element.props.children === "Disconnect"),
    ).not.toBeNull();
  });

  it("shows a failed connection inside the dialog", async () => {
    connectionState.data = {
      status: "unauthenticated",
      hasStoredToken: false,
      accountName: null,
      accountEmail: null,
      teams: [],
    };
    connectionState.error = null;
    commands.connect.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("Invalid Linear API key"))),
    );
    const props = { open: true, onOpenChange: vi.fn(), onProviderChanged: vi.fn() };

    hooks.beginRender();
    let dialog = LinearConnectionDialog(props);
    const input = visitElements(
      dialog,
      (element) => element.type === Input && element.props["aria-label"] === "Linear API key",
    );
    (
      input?.props.onChange as ((event: { currentTarget: { value: string } }) => void) | undefined
    )?.({ currentTarget: { value: "bad-key" } });

    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
    const form = visitElements(dialog, (element) => element.type === "form");
    await (
      form?.props.onSubmit as ((event: { preventDefault: () => void }) => Promise<void>) | undefined
    )?.({ preventDefault: vi.fn() });

    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
    expect(visitElements(dialog, (element) => element.props.role === "alert")?.props.children).toBe(
      "Invalid Linear API key",
    );
  });

  it("does not change the provider filter when replacing a key", async () => {
    connectionState.error = null;
    commands.connect.mockResolvedValue(AsyncResult.success(undefined));
    const onProviderChanged = vi.fn();
    const props = { open: true, onOpenChange: vi.fn(), onProviderChanged };

    hooks.beginRender();
    let dialog = LinearConnectionDialog(props);
    const input = visitElements(
      dialog,
      (element) =>
        element.type === Input && element.props["aria-label"] === "Replace Linear API key",
    );
    (
      input?.props.onChange as ((event: { currentTarget: { value: string } }) => void) | undefined
    )?.({ currentTarget: { value: "new-key" } });

    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
    const form = visitElements(dialog, (element) => element.type === "form");
    await (
      form?.props.onSubmit as ((event: { preventDefault: () => void }) => Promise<void>) | undefined
    )?.({ preventDefault: vi.fn() });
    await commands.connect.mock.results[0]?.value;
    await Promise.resolve();

    expect(onProviderChanged).toHaveBeenCalledWith("updated");
  });
});
