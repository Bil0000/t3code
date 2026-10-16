// @vitest-environment jsdom

import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { collapseExpandedComposerCursor } from "~/composer-logic";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

const draft =
  "> **Assistant and reasoning text still save intermediate full snapshots**, using the existing 50 ms batching. Compaction still preserves their `turn-item.updated` events. [Code](/Users/yashsingh/p/projects/t3code/apps/server/src/orchestration-v2/ProjectionMaintenance.ts:235)";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
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

async function mountEditor(
  value: string,
  richTextEnabled = true,
  editorRef = createRef<ComposerPromptEditorHandle>(),
) {
  await act(async () =>
    root.render(
      <ComposerPromptEditor
        editorRef={editorRef}
        value={value}
        cursor={0}
        richTextEnabled={richTextEnabled}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={() => {}}
        onPaste={() => {}}
      />,
    ),
  );
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

function press(editor: Editor, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, cancelable: true, ...options });
  const handled = editor.view.props.handleKeyDown?.(editor.view, event);
  expect(event.defaultPrevented).toBe(Boolean(handled));
  return handled;
}

it.each([
  {
    value: "Ultrathink:\nAlpha beta gamma",
    expected: "Ultrathink:\nAlpha X gamma",
  },
  { value: "Alpha beta gamma", expected: "Alpha X gamma" },
])(
  "restores the editing range after an effort prefix change to $value",
  async ({ value, expected }) => {
    const start = value.indexOf("beta");
    const end = start + "beta".length;
    const editorRef = createRef<ComposerPromptEditorHandle>();
    const editor = await mountEditor(value, true, editorRef);
    editor.view.setProps({ handleScrollToSelection: () => true });
    await act(async () => {
      editorRef.current?.focusAt(
        collapseExpandedComposerCursor(value, start),
        collapseExpandedComposerCursor(value, end),
      );
      expect(editorRef.current?.readSelectionRange()).toEqual({ start, end });
      editor.commands.insertContent("X");
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe(expected);
  },
);

it("keeps Up before the opening bold marker in a quote, including while typing", async () => {
  const editor = await mountEditor(draft);
  const position = editor.state.selection.from;
  await act(async () => {
    editor.view.focus();
    expect(press(editor, "ArrowUp")).toBe(true);
    expect(editor.state.selection.from).toBe(position);
    editor.view.updateState(editor.state);
    const marker = editor.view.dom.querySelector(".composer-rich-marker");
    const caret = window.getSelection()?.getRangeAt(0);
    if (!marker || !caret) throw new Error("Caret or bold marker is missing");
    const markerRange = document.createRange();
    markerRange.selectNode(marker);
    expect(caret.compareBoundaryPoints(Range.START_TO_START, markerRange)).toBeLessThanOrEqual(0);
    expect(press(editor, "ArrowUp")).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> x**"));
});

it("keeps Down after a closing marker, including while typing", async () => {
  const editor = await mountEditor("> **bold**");
  await act(async () => {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
    expect(press(editor, "ArrowDown")).toBe(true);
    expect(press(editor, "ArrowDown")).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("> **bold**x");
});

it("leaves vertical navigation between paragraphs to the browser", async () => {
  const editor = await mountEditor("**first**\n**second**");
  await act(async () => {
    const first = editor.state.doc.child(0);
    editor.commands.setTextSelection(first.nodeSize + 1);
    expect(press(editor, "ArrowUp")).toBe(false);
    editor.commands.setTextSelection(first.nodeSize - 1);
    expect(press(editor, "ArrowDown")).toBe(false);
  });
});

it.each([
  { shiftKey: true },
  { altKey: true },
  { metaKey: true },
  { ctrlKey: true },
  { isComposing: true },
])("preserves modified Up behavior for %j", async (options) => {
  const editor = await mountEditor(draft);
  await act(async () => {
    expect(press(editor, "ArrowUp", options)).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> **x"));
});

it("leaves literal Markdown navigation to the browser in plain mode", async () => {
  const editor = await mountEditor(draft, false);
  await act(async () => {
    editor.commands.setTextSelection(5);
    expect(press(editor, "ArrowUp")).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> **x"));
});
