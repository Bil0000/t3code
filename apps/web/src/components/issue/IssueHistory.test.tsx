// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock("~/state/issues", async () => {
  const { useState } = await import("react");
  const first = {
    id: "first",
    kind: "changed",
    detail: "First event",
    actor: null,
    createdAt: "2026-10-14T00:00:00Z",
  };
  return {
    useIssueHistory: () => {
      const [recovered, setRecovered] = useState(false);
      return {
        items: recovered ? [first, { ...first, id: "second", detail: "Later event" }] : [first],
        error: recovered ? null : "Temporary tracker failure",
        isPending: false,
        hasMore: !recovered,
        truncated: false,
        loadMore: () => setRecovered(true),
      };
    },
  };
});
import { IssueHistory } from "./IssueHistory";

it("shows the later-page failure and can retry while keeping earlier history", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const reference = {
    projectId: ProjectId.make("project"),
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "org/repo",
    key: "1",
  };
  try {
    await act(async () =>
      root.render(
        <IssueHistory environmentId={EnvironmentId.make("environment")} reference={reference} />,
      ),
    );
    expect(container.textContent).toContain("First event");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Temporary tracker failure",
    );
    const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Load more history",
    )!;
    await act(async () => retry.click());
    expect(container.textContent).toContain("First event");
    expect(container.textContent).toContain("Later event");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
