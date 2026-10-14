import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, IssueTrackerKind } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom } from "effect/reactivity";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createElement, useEffect } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../hooks/useIssueViewRefresh", () => ({ useIssueViewRefresh: () => {} }));
vi.mock("@t3tools/client-runtime/state/issues", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const pages = Atom.family((_key: string) =>
    Atom.make(AsyncResult.success({ items: [], nextCursor: null })).pipe(Atom.keepAlive),
  );
  const family = (target: unknown) => pages(JSON.stringify(target));
  return {
    createIssueEnvironmentAtoms: () => ({
      history: family,
      linkedPullRequests: family,
      hierarchy: family,
      labelCandidates: family,
      assigneeCandidates: family,
    }),
  };
});

import { appAtomRegistry } from "../rpc/atomRegistry";
import { issueEnvironment, useIssueHistory, type IssuePagedView } from "./issues";
import type { IssueEvent, IssueHistoryPage } from "@t3tools/contracts";

const environmentId = EnvironmentId.make("environment");
const input = {
  projectId: ProjectId.make("project"),
  tracker: IssueTrackerKind.make("jira"),
  host: "jira.example",
  scope: "ENG",
  key: "ENG-1",
};
const event = (id: string): IssueEvent => ({
  id,
  kind: "changed",
  actor: null,
  createdAt: "2026-10-14T00:00:00Z",
  detail: id,
});
let root: ReactTestRenderer | undefined;
let view: IssuePagedView<IssueEvent>;
function Probe() {
  const current = useIssueHistory(environmentId, input);
  useEffect(() => {
    view = current;
  }, [current]);
  return null;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
});

it("drops retained pages when the native first page changes with the same cursor", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const first = issueEnvironment.history({ environmentId, input }) as Atom.Writable<
    AsyncResult.AsyncResult<IssueHistoryPage, unknown>
  >;
  const second = issueEnvironment.history({
    environmentId,
    input: { ...input, cursor: "next" },
  }) as Atom.Writable<AsyncResult.AsyncResult<IssueHistoryPage, unknown>>;
  appAtomRegistry.set(first, AsyncResult.success({ items: [event("newest")], nextCursor: "next" }));
  appAtomRegistry.set(second, AsyncResult.success({ items: [event("older")], nextCursor: "next" }));
  await act(async () => {
    root = create(
      createElement(RegistryContext.Provider, { value: appAtomRegistry }, createElement(Probe)),
    );
  });
  await act(async () => view.loadMore());
  expect(view.items.map((item) => item.id)).toEqual(["newest", "older"]);
  expect(view.hasMore).toBe(false);
  await act(async () => view.loadMore());
  expect(view.items).toHaveLength(2);
  await act(async () => {
    appAtomRegistry.set(
      first,
      AsyncResult.success({ items: [event("replacement")], nextCursor: "next" }),
    );
  });
  expect(view.items.map((item) => item.id)).toEqual(["replacement"]);
  expect(view.hasMore).toBe(true);
});

it("keeps a failed continuation available for retry without dropping earlier items", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const first = issueEnvironment.history({ environmentId, input }) as Atom.Writable<
    AsyncResult.AsyncResult<IssueHistoryPage, unknown>
  >;
  const second = issueEnvironment.history({
    environmentId,
    input: { ...input, cursor: "retry" },
  }) as Atom.Writable<AsyncResult.AsyncResult<IssueHistoryPage, unknown>>;
  appAtomRegistry.set(first, AsyncResult.success({ items: [event("first")], nextCursor: "retry" }));
  appAtomRegistry.set(second, AsyncResult.failure(Cause.fail("offline")));
  await act(async () => {
    root = create(
      createElement(RegistryContext.Provider, { value: appAtomRegistry }, createElement(Probe)),
    );
  });
  await act(async () => view.loadMore());
  expect(view.items.map((item) => item.id)).toEqual(["first"]);
  expect(view.hasMore).toBe(true);
  const refresh = vi.spyOn(appAtomRegistry, "refresh");
  try {
    await act(async () => view.loadMore());
    expect(refresh).toHaveBeenCalledExactlyOnceWith(second);
    await act(async () =>
      appAtomRegistry.set(
        second,
        AsyncResult.success({ items: [event("recovered")], nextCursor: null }),
      ),
    );
    expect(view.items.map((item) => item.id)).toEqual(["first", "recovered"]);
    expect(view.hasMore).toBe(false);
  } finally {
    refresh.mockRestore();
  }
});
