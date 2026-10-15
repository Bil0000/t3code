// @vitest-environment jsdom

import { RegistryContext } from "@effect/atom-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import type { IssueEvent, IssueHistoryPage } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("~/hooks/useIssueViewRefresh", () => ({ useIssueViewRefresh: () => {} }));
vi.mock("@t3tools/client-runtime/state/issues", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const pages = Atom.family((_key: string) => {
    const value = Atom.make<AsyncResult.AsyncResult<IssueHistoryPage, unknown>>(
      AsyncResult.success({ items: [], nextCursor: null }),
    ).pipe(Atom.keepAlive);
    return Atom.writable(
      (get) => get(value),
      (get, result: AsyncResult.AsyncResult<IssueHistoryPage, unknown>) => get.set(value, result),
      () => undefined,
    ).pipe(Atom.keepAlive);
  });
  return {
    createIssueEnvironmentAtoms: () => ({
      history: (target: unknown) => pages(JSON.stringify(target)),
    }),
  };
});
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { issueEnvironment } from "~/state/issues";
import { IssueHistory } from "./IssueHistory";

const environmentId = EnvironmentId.make("environment");
const reference = {
  projectId: ProjectId.make("project"),
  tracker: IssueTrackerKind.make("github"),
  host: "github.com",
  scope: "org/repo",
  key: "1",
};
const event = (detail: string): IssueEvent => ({
  id: detail,
  kind: "changed",
  detail,
  actor: null,
  createdAt: "2026-10-14T00:00:00Z",
});
const page = (cursor?: string) =>
  issueEnvironment.history({ environmentId, input: { ...reference, cursor } }) as Atom.Writable<
    AsyncResult.AsyncResult<IssueHistoryPage, unknown>
  >;
let container: HTMLDivElement;
let root: Root;
const loadMore = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Load more history",
  );
const render = () =>
  act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <IssueHistory environmentId={environmentId} reference={reference} />
      </RegistryContext.Provider>,
    ),
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shows the later-page failure and can retry while keeping earlier history", async () => {
  appAtomRegistry.set(
    page(),
    AsyncResult.success({ items: [event("First event")], nextCursor: "next" }),
  );
  const next = page("next");
  appAtomRegistry.set(
    next,
    AsyncResult.failure(Cause.fail(new Error("Temporary tracker failure"))),
  );
  await render();
  await act(async () => loadMore()!.click());
  expect(container.textContent).toContain("First event");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Temporary tracker failure",
  );
  const refresh = vi.spyOn(appAtomRegistry, "refresh").mockImplementation((atom) => {
    if (atom === next)
      appAtomRegistry.set(
        next,
        AsyncResult.success({ items: [event("Later event")], nextCursor: null }),
      );
  });
  await act(async () => loadMore()!.click());
  expect(refresh).toHaveBeenCalledExactlyOnceWith(next);
  expect(container.textContent).toContain("First event");
  expect(container.textContent).toContain("Later event");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it.each(["2", "notes:2"])("loads history after an empty native page (%s)", async (cursor) => {
  appAtomRegistry.set(page(), AsyncResult.success({ items: [], nextCursor: cursor }));
  appAtomRegistry.set(
    page(cursor),
    AsyncResult.success({ items: [event("State changed")], nextCursor: null }),
  );
  await render();
  expect(loadMore()).toBeDefined();
  expect(container.textContent).not.toContain("No history yet.");
  await act(async () => loadMore()!.click());
  expect(container.textContent).toContain("State changed");
  expect(loadMore()).toBeUndefined();
});

it("can retry a failed history continuation when all earlier pages are empty", async () => {
  appAtomRegistry.set(page(), AsyncResult.success({ items: [], nextCursor: "notes:2" }));
  const next = page("notes:2");
  appAtomRegistry.set(
    next,
    AsyncResult.failure(Cause.fail(new Error("Temporary tracker failure"))),
  );
  await render();
  expect(loadMore()).toBeDefined();
  await act(async () => loadMore()!.click());
  expect(container.textContent).toContain("Temporary tracker failure");
  expect(loadMore()).toBeDefined();
  const refresh = vi.spyOn(appAtomRegistry, "refresh").mockImplementation((atom) => {
    if (atom === next)
      appAtomRegistry.set(
        next,
        AsyncResult.success({ items: [event("State changed")], nextCursor: null }),
      );
  });
  await act(async () => loadMore()!.click());
  expect(refresh).toHaveBeenCalledExactlyOnceWith(next);
  expect(container.textContent).toContain("State changed");
  expect(loadMore()).toBeUndefined();
  expect(container.textContent).not.toContain("Temporary tracker failure");
});

it("keeps the empty terminal history message without a continuation", async () => {
  appAtomRegistry.set(page(), AsyncResult.success({ items: [], nextCursor: null }));
  await render();
  expect(container.textContent).toContain("No history yet.");
  expect(loadMore()).toBeUndefined();
});

it("keeps the initial history error without a continuation", async () => {
  appAtomRegistry.set(
    page(),
    AsyncResult.failure(Cause.fail(new Error("Initial tracker failure"))),
  );
  await render();
  expect(container.textContent).toContain("The history could not be read. Initial tracker failure");
  expect(loadMore()).toBeUndefined();
});
