// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { IssueTrackerKind, ProjectId, type IssueDetail } from "@t3tools/contracts";
import type {
  EnvironmentRegistry as Registry,
  EnvironmentSupervisor as Supervisor,
} from "@t3tools/client-runtime/connection";
import * as RpcClient from "../../../../../packages/client-runtime/src/rpc/client";

type Props = { readonly children?: ReactNode; readonly onPress?: () => void };

const harness = vi.hoisted(() => ({ focus: () => {}, back: 0 }));

vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
  Platform: { OS: "ios" },
  Pressable: ({ children, onPress, disabled }: Props & { disabled?: boolean }) => (
    <button disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  RefreshControl: () => null,
  ScrollView: ({ children }: Props) => children,
  View: ({ children }: Props) => children,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
  useFocusEffect: (effect: () => void) => {
    harness.focus = effect;
  },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/AppText", () => ({ AppText: ({ children }: Props) => children }));
vi.mock("../../components/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ControlPillMenu", () => ({ ControlPillMenu: () => null }));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: () => null,
  NativeHeaderToolbar: Object.assign(() => null, {
    Menu: () => null,
    MenuAction: () => null,
    Label: () => null,
  }),
}));
vi.mock("../../native/useOpenPullRequest", () => ({ useOpenPullRequest: () => vi.fn() }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false } }),
}));
vi.mock("../layout/workspace-sidebar-toolbar", () => ({
  AndroidWorkspaceSidebarButton: () => null,
}));
vi.mock("../workspace/useAndroidWorkspaceNavigation", () => ({
  useAndroidWorkspaceBack: () => () => harness.back++,
}));
vi.mock("../pull-requests/PullRequestControls", () => ({
  PullRequestCardGroup: () => null,
  PullRequestCardRow: () => null,
}));
vi.mock("../pull-requests/PullRequestMarkdown", () => ({ PullRequestMarkdown: () => null }));
vi.mock("../pull-requests/PullRequestPresentation", () => ({ PullRequestAvatar: () => null }));
vi.mock("./IssueReactions", () => ({ IssueReactions: () => null }));
vi.mock("./useIssueAccess", async () => {
  const { issueAccess } = await import("./issueDetail");
  const grants = { connected: true, comment: false, update: false, setState: false, react: false };
  return {
    issueTarget: ({ environmentId, ...input }: Record<string, string>) => ({
      environmentId,
      input,
    }),
    markIssueTargetWritten: vi.fn(),
    useIssueAccess: (_params: unknown, detail: IssueDetail | null) => ({
      connected: true,
      ...issueAccess(detail, grants),
    }),
  };
});
vi.mock("../../state/issues", async () => {
  const { AVAILABLE_CONNECTION_STATE, EnvironmentRegistry, EnvironmentSupervisor } =
    await import("@t3tools/client-runtime/connection");
  const { createIssueEnvironmentAtoms } = await import("@t3tools/client-runtime/state/issues");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Option = await import("effect/Option");
  const Stream = await import("effect/Stream");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const { Atom } = await import("effect/reactivity");
  const environments = Layer.effect(
    EnvironmentRegistry.EnvironmentRegistry,
    Effect.gen(function* () {
      const supervisor = {
        state: yield* SubscriptionRef.make({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected" as const,
        }),
        session: yield* SubscriptionRef.make(Option.some({})),
      } as unknown as Supervisor.EnvironmentSupervisor["Service"];
      return EnvironmentRegistry.EnvironmentRegistry.of({
        run: (_id, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as Registry.EnvironmentRegistry["Service"]);
    }),
  );
  return { issueEnvironment: createIssueEnvironmentAtoms(Atom.runtime(environments)) };
});

import { IssueRouteScreen } from "./IssueRouteScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function detail(title: string): IssueDetail {
  return {
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "org/repo",
    key: "1",
    displayKey: "#1",
    projectId: ProjectId.make("project"),
    projectTitle: "Project",
    title,
    url: "https://example.com/issue",
    author: null,
    state: { category: "open", name: "Open" },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    writable: true,
    viewer: "viewer",
    body: "",
    comments: [],
    commentsCursor: null,
    events: [],
    linkedPullRequests: [],
    capabilities: {
      create: true,
      edit: true,
      comment: true,
      labels: true,
      assignees: true,
      reactions: false,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: true,
      states: [],
      closeReasons: [],
    },
    viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
  };
}

const request = vi.spyOn(RpcClient, "request");
afterEach(() => request.mockReset());

const settle = async () => {
  for (let index = 0; index < 5; index += 1) await act(() => Promise.resolve());
};

it("keeps a cached issue on a failed refresh, says so, and recovers through Retry", async () => {
  const answers = [detail("Old title"), new Error("API rate limit exceeded"), detail("New title")];
  let reads = 0;
  request.mockImplementation((() =>
    Effect.suspend(() => {
      const answer = answers[reads++]!;
      return answer instanceof Error ? Effect.fail(answer) : Effect.succeed(answer);
    })) as unknown as Parameters<typeof request.mockImplementation>[0]);
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <IssueRouteScreen
          route={{
            params: {
              environmentId: "environment",
              projectId: "project",
              tracker: "github",
              host: "github.com",
              scope: "org/repo",
              key: "1",
            },
          }}
        />
      </RegistryContext.Provider>,
    ),
  );
  await settle();
  expect(container.textContent).toContain("Old title");
  expect(container.textContent).not.toContain("Couldn't refresh");

  await act(() => harness.focus());
  await settle();
  expect(reads).toBe(2);
  expect(container.textContent).toContain("Old title");
  expect(container.textContent).toContain("Couldn't refresh this issue: API rate limit exceeded");

  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  );
  await act(() => retry!.click());
  await settle();
  expect(reads).toBe(3);
  expect(container.textContent).toContain("New title");
  expect(container.textContent).not.toContain("Couldn't refresh");

  await act(() => root.unmount());
  registry.dispose();
});

it.each([{ environmentId: " " }, { projectId: "" }, { tracker: "Not A Tracker" }])(
  "shows a way back instead of reading an issue from invalid link params %j",
  async (change) => {
    harness.back = 0;
    const registry = AtomRegistry.make();
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <IssueRouteScreen
            route={{
              params: {
                environmentId: "environment",
                projectId: "project",
                tracker: "github",
                host: "github.com",
                scope: "org/repo",
                key: "1",
                ...change,
              },
            }}
          />
        </RegistryContext.Provider>,
      ),
    );
    await settle();
    expect(request).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Couldn't open this issue");
    const back = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Back to issues",
    );
    await act(() => back!.click());
    expect(harness.back).toBe(1);
    await act(() => root.unmount());
    registry.dispose();
  },
);
