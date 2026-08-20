import { ProjectId, type IssueListEntry } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

const matchingIssue = {
  provider: "github",
  host: "github.com",
  projectId: ProjectId.make("project-1"),
  projectTitle: "T3 Code",
  repository: "pingdotgg/t3code",
  number: 7606,
  title: "[Bug]: Pull request screens are missing pointer cursors on clickable elements",
  url: "https://github.com/pingdotgg/t3code/issues/7606",
  author: { login: "octocat", name: null, avatarUrl: null },
  state: "open",
  stateReason: null,
  createdAt: "2026-08-20T00:00:00Z",
  updatedAt: "2026-08-20T00:00:00Z",
  closedAt: null,
  assignees: [],
  labels: [],
  milestone: null,
  commentCount: 0,
} as IssueListEntry;

vi.mock("~/state/issues", () => ({
  issueEnvironment: {
    list: ({ input }: { input: { readonly query?: string } }) =>
      input.query === undefined ? "baseline" : "searched",
  },
}));
vi.mock("~/state/queries", () => ({
  useDebouncedValue: (value: string) => value,
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: "baseline" | "searched") => ({
    data:
      query === "baseline"
        ? {
            viewers: {},
            providers: [{ kind: "github", host: "github.com", searchesOnHost: false }],
            entries: [matchingIssue],
            errors: [],
            truncated: false,
            nextCursors: {},
          }
        : {
            viewers: {},
            providers: [{ kind: "github", host: "github.com", searchesOnHost: false }],
            entries: [],
            errors: [],
            truncated: false,
            nextCursors: {},
          },
    error: null,
    isPending: false,
    refresh: () => undefined,
  }),
}));

import { IssuesPanel } from "./IssuesPanel";

function renderSearch(query: string): string {
  hooks.reset();
  hooks.beginRender();
  const project = IssuesPanel({
    environmentId: "environment-1" as never,
    projectId: "project-1" as never,
    selected: null,
    onSelect: () => undefined,
    handoffTarget: { kind: "new-thread" },
    onStateChange: () => undefined,
  }) as ReactElement;
  const list = (project.type as (props: unknown) => ReactElement)(project.props) as ReactElement<{
    readonly query: string;
  }>;

  hooks.reset();
  hooks.beginRender();
  const browser = (list.type as (props: unknown) => ReactElement)({ ...list.props, query });
  return renderToStaticMarkup(browser);
}

describe("IssuesPanel", () => {
  it("keeps a title match when a locally searched host returns no remote matches", () => {
    expect(renderSearch("pointer cursors")).toContain(matchingIssue.title);
  });
});
