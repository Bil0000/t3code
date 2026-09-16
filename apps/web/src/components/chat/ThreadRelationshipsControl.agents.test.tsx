import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/entities", () => ({
  useThreadProjection: () => ({ projection: state.projection }),
  useThreadShells: () => [],
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots: [] }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));

import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

let renderer: ReactTestRenderer;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("shows the matching child agent details and refreshes them when the agent settles", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const agent = {
    id: "agent-1",
    childThreadId: "child-1",
    title: "Checker",
    prompt: "Check the change",
    model: "gpt-5.4",
    status: "running",
    progress: "Running checks",
    result: null,
    startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
  };
  const projection = {
    thread: {
      id: "parent",
      lineage: { relationshipToParent: null },
      activeProviderThreadId: null,
    },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      { ...agent, id: "unlinked", childThreadId: null, title: "Unlinked agent" },
      agent,
      { ...agent, id: "agent-2", childThreadId: "child-2", title: "Worker", model: "gpt-5.3" },
    ],
  };
  state.projection = projection;
  const panel = (
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />
  );
  await act(async () => {
    renderer = create(panel);
  });
  const text = () =>
    renderer.root
      .findAll((node) => typeof node.type === "string")
      .flatMap((node) => node.children.filter((child) => typeof child === "string"))
      .join(" ");
  expect(text()).toContain("Checker");
  expect(text()).toContain("Running checks");
  expect(text()).toContain("gpt-5.4");
  expect(text()).toContain("gpt-5.3");
  expect(text()).toContain("— tok");
  expect(text()).not.toContain("Unlinked agent");
  await act(async () =>
    renderer.root.findByProps({ type: "button", "aria-expanded": true }).props.onClick(),
  );
  expect(text()).not.toContain("Running checks");
  await act(async () =>
    renderer.root.findByProps({ type: "button", "aria-expanded": false }).props.onClick(),
  );
  expect(text()).toContain("Running checks");

  state.projection = {
    ...projection,
    subagents: [
      {
        ...agent,
        status: "completed",
        progress: undefined,
        result: "All checks passed",
        completedAt: DateTime.makeUnsafe("2026-09-16T12:02:15Z"),
      },
    ],
  };
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("Previous agents");
  expect(text()).not.toContain("All checks passed");
  await act(async () =>
    renderer.root.findByProps({ type: "button", "aria-expanded": false }).props.onClick(),
  );
  expect(text()).toContain("All checks passed");
  expect(text()).toContain("2m 15s");
  expect(text()).toContain("Completed");
  expect(text()).not.toContain("Running checks");
  expect(text()).not.toContain("Worker");

  state.projection = {
    ...projection,
    subagents: Array.from({ length: 8 }, (_, index) => ({
      ...agent,
      id: `old-agent-${index}`,
      childThreadId: `old-child-${index}`,
      status: index === 7 ? "failed" : "completed",
      title: `Old agent ${index}`,
      result: index === 7 ? "Earlier build failed" : "Done",
      completedAt: DateTime.makeUnsafe("2026-09-16T12:02:15Z"),
    })),
  };
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("1  failed");
  expect(text()).not.toContain("Earlier build failed");
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Show "))!
      .props.onClick(),
  );
  expect(text()).toContain("Earlier build failed");
  expect(text()).toContain("Old agent 7");
});
