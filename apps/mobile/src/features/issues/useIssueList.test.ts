// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  type IssueCapabilities,
  type IssueListInput,
  type IssueListEntry,
  type IssueListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import * as RpcClient from "../../../../../packages/client-runtime/src/rpc/client.ts";
import * as EnvironmentRegistry from "../../../../../packages/client-runtime/src/connection/registry.ts";
import * as EnvironmentSupervisor from "../../../../../packages/client-runtime/src/connection/supervisor.ts";
import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import * as Layer from "effect/Layer";

vi.mock("../../state/issues", () => ({ issueEnvironment: {} }));

import { issueEnvironment } from "../../state/issues";
import { useIssueList, type IssueListTarget } from "./useIssueList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (key: string, overrides: Partial<IssueListEntry> = {}): IssueListEntry => ({
  tracker: IssueTrackerKind.make("gitlab"),
  host: "gitlab.example",
  scope: "group/app",
  displayKey: `#${key}`,
  title: key,
  url: `https://gitlab.example/group/app/-/issues/${key}`,
  author: null,
  state: { category: "open", name: "open" },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  closedAt: null,
  assignees: [],
  labels: [],
  commentCount: 0,
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  ...overrides,
  key,
});
const source = (entry: IssueListEntry) => ({ ...entry, capabilities: {} as IssueCapabilities });
const cursor = "gitlab gitlab.example group/app";
const failedCursor = "gitlab gitlab.example group/failed";
const otherCursor = "github github.example group/other";

it.each([
  { viewer: "A", switchFilter: false, companion: null },
  { viewer: "B", switchFilter: false, companion: null },
  { viewer: "B", switchFilter: true, companion: null },
  { viewer: "A", switchFilter: false, companion: "waiting" },
  { viewer: "A", switchFilter: false, companion: "failed" },
  { viewer: "B", switchFilter: false, companion: "ready" },
])(
  "restarts only the current changed viewer from page one: %j",
  async ({ viewer, switchFilter, companion }) => {
    const firstRows = Array.from({ length: 50 }, (_, index) => row(`A-${index}`));
    const failed = row("failed", { scope: "group/failed", projectId: ProjectId.make("failed") });
    const other = row("other", {
      tracker: IssueTrackerKind.make("github"),
      host: "github.example",
      scope: "group/other",
      projectId: ProjectId.make("other"),
    });
    const otherTail = row("other-tail", other);
    const first: IssueListResult = {
      entries: [...firstRows, failed, other],
      sources: [source(firstRows[0]!), source(failed), source(other)],
      nextCursors: { [cursor]: "2", [failedCursor]: "F2", [otherCursor]: "O2" },
      viewers: { "gitlab gitlab.example": "A", "github github.example": "other" },
      trackers: [],
      errors: [],
    };
    const continued: IssueListResult = {
      ...first,
      entries: [otherTail],
      viewers: { ...first.viewers, "gitlab gitlab.example": viewer },
      nextCursors: { [otherCursor]: "O3" },
      errors: [
        {
          projectId: failed.projectId,
          projectTitle: failed.projectTitle,
          tracker: failed.tracker,
          host: failed.host,
          message: "unavailable",
        },
      ],
    };
    const fresh: IssueListResult = {
      ...continued,
      entries: [row("B-first")],
      sources: [source(firstRows[0]!)],
      nextCursors: {},
      errors: [],
    };
    const pageRequest = vi.spyOn(RpcClient, "requestGuarded");
    const restarts = viewer === "B" && !switchFilter;
    const replies = restarts ? [first, continued, fresh] : [first, continued];
    const companionPage = Promise.withResolvers<IssueListResult>();
    const continuation = Promise.withResolvers<IssueListResult>();
    const started = Promise.withResolvers<void>();
    pageRequest.mockImplementation(((_tag: string, input: IssueListInput) => {
      if (companion === "ready" && input.cursors?.[cursor] === "offline-2")
        return Effect.promise(() => companionPage.promise);
      const reply = replies.shift()!;
      if (reply === fresh)
        companionPage.resolve({
          ...offline,
          entries: [row("offline-tail")],
          nextCursors: { [cursor]: "offline-3" },
        });
      if (switchFilter && reply === continued) {
        started.resolve();
        return Effect.promise(() => continuation.promise);
      }
      return Effect.succeed(reply);
    }) as unknown as Parameters<typeof pageRequest.mockImplementation>[0]);
    const runtime = Atom.runtime(
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        EnvironmentRegistry.EnvironmentRegistry.of({
          run: (_environmentId, effect) =>
            Effect.provideService(
              effect,
              EnvironmentSupervisor.EnvironmentSupervisor,
              {} as EnvironmentSupervisor.EnvironmentSupervisor["Service"],
            ),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      ),
    );
    Object.assign(issueEnvironment, createIssueEnvironmentAtoms(runtime));
    const registry = AtomRegistry.make();
    const target: IssueListTarget = {
      environmentId: EnvironmentId.make(`environment-${viewer}-${switchFilter}-${companion}`),
      input: { state: "all", involvement: "assigned", limit: 50 },
    };
    const initial = await issueEnvironment.listPage.run(registry, target);
    if (initial._tag !== "Success") throw new Error("initial list failed");
    const offlineTarget = {
      ...target,
      environmentId: EnvironmentId.make(`${target.environmentId}-offline`),
    };
    const offline = { ...first, entries: [row("offline")], nextCursors: { [cursor]: "offline-2" } };
    const list = Atom.family((selected: IssueListTarget) =>
      Atom.make<AsyncResult.AsyncResult<IssueListResult, Error>>(
        AsyncResult.success(
          selected.environmentId === offlineTarget.environmentId ? offline : initial.value,
        ),
      ),
    );
    issueEnvironment.list = list;
    const root = createRoot(document.createElement("div"));
    let result: ReturnType<typeof useIssueList>;
    let targets = companion ? [target, offlineTarget] : [target];
    function Probe() {
      const current = useIssueList(targets);
      useLayoutEffect(() => {
        result = current;
      });
      return null;
    }
    try {
      await act(async () =>
        root.render(
          createElement(RegistryContext.Provider, { value: registry }, createElement(Probe)),
        ),
      );
      expect(result!.lists[0]?.held.entries).toHaveLength(52);
      if (companion === "waiting" || companion === "failed") {
        await act(async () =>
          registry.set(
            list(offlineTarget),
            companion === "waiting"
              ? AsyncResult.waiting(registry.get(list(offlineTarget)))
              : AsyncResult.failure(Cause.fail(new Error("offline"))),
          ),
        );
      }
      if (switchFilter) {
        let pending: Promise<void>;
        await act(async () => {
          pending = result!.loadMore();
          await started.promise;
        });
        targets = [{ ...target, input: { ...target.input, state: "open" } }];
        await act(async () =>
          root.render(
            createElement(RegistryContext.Provider, { value: registry }, createElement(Probe)),
          ),
        );
        await act(async () => {
          continuation.resolve(continued);
          await pending!;
        });
      } else {
        await act(async () => result!.loadMore());
      }
      expect(pageRequest.mock.calls.map(([tag]) => tag)).toEqual(
        Array(restarts ? (companion === "ready" ? 4 : 3) : 2).fill("issues.list"),
      );
      expect(pageRequest.mock.calls[1]?.[1]).toMatchObject({ cursors: first.nextCursors });
      if (restarts) {
        expect(pageRequest.mock.calls[companion === "ready" ? 3 : 2]?.[1]).toEqual({
          state: "all",
          involvement: "assigned",
          projectId: firstRows[0]!.projectId,
          host: "gitlab.example",
          limit: 50,
        });
        expect(result!.lists[0]?.held.entries.map((entry) => entry.key)).toEqual([
          "failed",
          "other",
          "other-tail",
          "B-first",
        ]);
      } else {
        expect(result!.lists[0]?.held.entries.map((entry) => entry.key)).toEqual(
          (switchFilter ? first.entries : [...first.entries, otherTail]).map((entry) => entry.key),
        );
      }
      expect(result!.lists[0]?.held.nextCursors).toEqual(
        switchFilter ? first.nextCursors : { [failedCursor]: "F2", [otherCursor]: "O3" },
      );
      expect(replies).toEqual([]);
      if (companion) {
        const held = result!.lists.find(
          (source) => source.environmentId === offlineTarget.environmentId,
        )!.held;
        expect(held.entries).toEqual(
          companion === "ready" ? [...offline.entries, row("offline-tail")] : offline.entries,
        );
        expect(held.nextCursors).toEqual(
          companion === "ready" ? { [cursor]: "offline-3" } : offline.nextCursors,
        );
        targets = [offlineTarget];
        await act(async () =>
          root.render(
            createElement(RegistryContext.Provider, { value: registry }, createElement(Probe)),
          ),
        );
        expect(result!.hasMore).toBe(companion === "ready");
      }
    } finally {
      await act(async () => root.unmount());
      registry.dispose();
      pageRequest.mockRestore();
    }
  },
);
