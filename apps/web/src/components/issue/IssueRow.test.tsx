// @vitest-environment jsdom

import { EnvironmentId, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { compile } from "tailwindcss";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { IssueRow, type EnvironmentIssueEntry } from "./IssueRow";

const compactDisplayStyles = (await compile("@tailwind utilities;")).build([
  "flex",
  "inline-flex",
  "hidden",
]);
const entry: EnvironmentIssueEntry = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  tracker: IssueTrackerKind.make("github"),
  host: "github.com",
  scope: "org/repo",
  key: "1",
  displayKey: "#1",
  title: "A labeled issue",
  url: "https://github.com/org/repo/issues/1",
  author: null,
  state: { category: "open", name: "open" },
  createdAt: "2026-10-15T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
  labels: ["bug", "urgent", "web"].map((name) => ({ name, color: null })),
  assignees: [],
  commentCount: 0,
  closedAt: null,
};
let container: HTMLDivElement;
let root: Root;
let styles: HTMLStyleElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  styles = document.createElement("style");
  styles.textContent = compactDisplayStyles;
  document.head.append(styles);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  styles.remove();
  vi.unstubAllGlobals();
});
const visibleLabels = () =>
  [...container.querySelectorAll<HTMLElement>('[data-slot="badge"]')]
    .filter((badge) => {
      for (let element: HTMLElement | null = badge; element; element = element.parentElement) {
        if (getComputedStyle(element).display === "none") return false;
      }
      return true;
    })
    .map((badge) => badge.textContent);

it("keeps the first label and remaining count visible in compact rows as labels change", async () => {
  const select = vi.fn();
  const render = (current: EnvironmentIssueEntry) =>
    act(async () =>
      root.render(
        <IssueRow
          entry={current}
          selected={false}
          showScope={false}
          showTracker={false}
          onSelect={select}
        />,
      ),
    );
  await render(entry);
  expect(visibleLabels()).toEqual(["bug+2"]);
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(select).toHaveBeenCalledExactlyOnceWith(entry);
  await render({ ...entry, labels: entry.labels.slice(0, 1) });
  expect(visibleLabels()).toEqual(["bug"]);
  await render({ ...entry, labels: [] });
  expect(visibleLabels()).toEqual([]);
});
