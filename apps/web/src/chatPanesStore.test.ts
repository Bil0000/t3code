import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it } from "vite-plus/test";

import { useChatPaneDragStore } from "./chatPaneDragStore";
import { collectLeaves } from "./chatPanes.logic";
import { commitChatPaneDrop, openThreadInSplit, useChatPanesStore } from "./chatPanesStore";

const thread = (id: string) => scopeThreadRef(EnvironmentId.make("env"), ThreadId.make(id));
const threadIds = (index: number) =>
  collectLeaves(useChatPanesStore.getState().groups[index]!).map((leaf) => leaf.threadRef.threadId);

beforeEach(() => {
  useChatPanesStore.setState({ groups: [], focusedPaneId: null });
  useChatPaneDragStore.getState().end();
});

it("starts a second group when a thread is dropped on a thread outside the first", () => {
  openThreadInSplit(thread("a"), thread("b"));
  const first = useChatPanesStore.getState().groups[0]!;
  useChatPaneDragStore.getState().start({ threadRef: thread("d"), title: "D" });
  useChatPaneDragStore.setState({ target: { paneId: "route", zone: "right" } });
  expect(commitChatPaneDrop(thread("c"))).toEqual(thread("d"));
  expect(useChatPanesStore.getState().groups[0]).toBe(first);
  expect(threadIds(1)).toEqual(["c", "d"]);
});

it("moves a pane into another group and drops the group it emptied", () => {
  openThreadInSplit(thread("a"), thread("b"));
  openThreadInSplit(thread("c"), thread("d"));
  const [first, second] = useChatPanesStore.getState().groups;
  const b = collectLeaves(first!)[1]!;
  const d = collectLeaves(second!)[1]!;
  useChatPanesStore.getState().movePane(b.id, d.id, "bottom");
  expect(useChatPanesStore.getState().groups).toHaveLength(1);
  expect(threadIds(0)).toEqual(["c", "d", "b"]);
});

it("returns the remaining thread when the focused member closes", () => {
  openThreadInSplit(thread("a"), thread("b"));
  const root = useChatPanesStore.getState().groups[0]!;
  const focused = collectLeaves(root).find(
    (leaf) => leaf.id === useChatPanesStore.getState().focusedPaneId,
  )!;
  expect(useChatPanesStore.getState().closePane(focused.id)).toEqual(thread("a"));
  expect(useChatPanesStore.getState().groups).toEqual([]);
});

it.each([-1, 1.1, 0.5])("validates persisted pane ratio %s", async (ratio) => {
  openThreadInSplit(thread("a"), thread("b"));
  const root = useChatPanesStore.getState().groups[0]!;
  const groups = [{ ...root, ratio }];
  useChatPanesStore.setState({ groups: [], focusedPaneId: null });
  const { storage, name } = useChatPanesStore.persist.getOptions();
  await storage!.setItem(name!, { state: { groups, focusedPaneId: null } });
  await useChatPanesStore.persist.rehydrate();
  expect(useChatPanesStore.getState().groups).toEqual(ratio === 0.5 ? groups : []);
});
