import type {
  EnvironmentId,
  IssueCapabilities,
  IssueReaction,
  ProjectId,
} from "@t3tools/contracts";
import { act, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { IssueReactionBar } from "./IssueReactions";

const setReaction = vi.hoisted(() => vi.fn());
const cloneRender = vi.hoisted(
  () =>
    ({ render, children }: { render: ReactElement; children: ReactNode }) =>
      ({ ...render, props: { ...(render.props as object), children } }) as ReactElement,
);
vi.mock("~/state/issues", () => ({ issueEnvironment: { setReaction: "setReaction" } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => setReaction }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: cloneRender,
  TooltipPopup: () => null,
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: cloneRender,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
}));

const AZURE_CONTENTS = [
  "thumbs-up",
  "thumbs-down",
  "heart",
  "hooray",
  "laugh",
  "confused",
] as const;
const reactions: ReadonlyArray<IssueReaction> = [
  { content: "thumbs-up", count: 2, viewerHasReacted: false, actors: [] },
  { content: "rocket", count: 1, viewerHasReacted: false, actors: [] },
];

let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function renderBar(capabilities: Partial<IssueCapabilities>, subjectId?: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    renderer = create(
      <IssueReactionBar
        reactions={reactions}
        capabilities={capabilities as IssueCapabilities}
        subjectId={subjectId}
        environmentId={"environment-1" as EnvironmentId}
        reference={{ projectId: "project-1" as ProjectId, repository: "acme/web", number: 7 }}
        onRefresh={vi.fn()}
      />,
    );
  });
  const buttons = renderer.root.findAllByType("button");
  const named = (label: string) => buttons.find((button) => button.props["aria-label"] === label);
  return {
    picker: buttons
      .map((button) => button.props["aria-label"] as string)
      .filter((label) => !label.includes(",") && label !== "Add a reaction"),
    addButton: named("Add a reaction"),
    pill: (label: string) => named(label)!,
  };
}

it("offers Azure's six reactions on comments only, keeping unsupported counts read-only", async () => {
  const azure = { reactions: false, commentReactions: true, reactionContents: AZURE_CONTENTS };
  const comment = await renderBar(azure, "comment-1");
  expect(comment.picker).toEqual([
    "thumbs up",
    "thumbs down",
    "laugh",
    "hooray",
    "confused",
    "heart",
  ]);
  expect(comment.pill("thumbs up, 2").props.disabled).toBe(false);
  expect(comment.pill("rocket, 1").props.disabled).toBe(true);

  setReaction.mockResolvedValue({ _tag: "Success" });
  await act(() => comment.pill("thumbs up, 2").props.onClick());
  expect(setReaction).toHaveBeenCalledWith({
    environmentId: "environment-1",
    input: expect.objectContaining({ subjectId: "comment-1", content: "thumbs-up", reacted: true }),
  });

  const item = await renderBar(azure);
  expect(item.addButton).toBeUndefined();
  expect(item.pill("thumbs up, 2").props.disabled).toBe(true);
  expect(item.pill("rocket, 1").props.disabled).toBe(true);
});

it("keeps the full reaction set on hosts that list no contents", async () => {
  const github = await renderBar({ reactions: true }, "comment-1");
  expect(github.picker).toHaveLength(8);
  expect(github.pill("rocket, 1").props.disabled).toBe(false);
  expect((await renderBar({ reactions: true })).picker).toHaveLength(8);
});
