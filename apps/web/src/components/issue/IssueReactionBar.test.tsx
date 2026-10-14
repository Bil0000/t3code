// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import { IssueReactionBar } from "./IssueDetailPanel";

const state = vi.hoisted(() => ({ react: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.react }));

const environmentId = EnvironmentId.make("environment");
const reference = {
  projectId: ProjectId.make("project"),
  tracker: IssueTrackerKind.make("github"),
  host: "github.com",
  scope: "org/repo",
  key: "42",
};
const reactions = [
  { content: "thumbs-up" as const, count: 2, actors: [], viewerHasReacted: false },
];
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([undefined, "latest-comment", "held-older-comment"])(
  "retains a successful add when a reverse write fails with stale native data (%s)",
  async (subjectId) => {
    state.react
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockResolvedValueOnce({ _tag: "Failure" })
      .mockResolvedValueOnce({ _tag: "Success" });
    await act(async () =>
      root.render(
        <IssueReactionBar
          reactions={reactions}
          canReact
          contents={undefined}
          environmentId={environmentId}
          reference={reference}
          subjectId={subjectId}
        />,
      ),
    );
    const pill = () =>
      container.querySelector<HTMLButtonElement>('button[aria-label^="thumbs up,"]')!;
    await act(async () => pill().click());
    expect(pill().getAttribute("aria-pressed")).toBe("true");
    expect(pill().textContent).toContain("3");
    await act(async () => pill().click());
    expect(pill().getAttribute("aria-pressed")).toBe("true");
    expect(pill().textContent).toContain("3");
    await act(async () => pill().click());
    expect(pill().getAttribute("aria-pressed")).toBe("false");
    expect(pill().textContent).toContain("2");
    expect(state.react.mock.calls.map(([target]) => target.input.reacted)).toEqual([
      true,
      false,
      false,
    ]);
    for (const [target] of state.react.mock.calls)
      expect(target).toEqual({
        environmentId,
        input: {
          ...reference,
          ...(subjectId === undefined ? {} : { subjectId }),
          content: "thumbs-up",
          reacted: target.input.reacted,
        },
      });
  },
);

it.each([
  { canReact: false, contents: undefined },
  { canReact: true, contents: [] },
  { canReact: true, contents: ["heart" as const] },
])("keeps unsupported reaction counts read-only for %j", async ({ canReact, contents }) => {
  await act(async () =>
    root.render(
      <IssueReactionBar
        reactions={reactions}
        canReact={canReact}
        contents={contents}
        environmentId={environmentId}
        reference={reference}
      />,
    ),
  );
  const pill = container.querySelector<HTMLButtonElement>('button[aria-label^="thumbs up,"]')!;
  expect(pill.disabled).toBe(true);
  await act(async () => pill.click());
  expect(state.react).not.toHaveBeenCalled();
  expect(pill.textContent).toContain("2");
});
