import { act } from "react";
import { create } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

import { useListSearchShortcut } from "./ListTitlebarControls";

it("leaves find in an editor alone but focuses the list from elsewhere", async () => {
  const events = new EventTarget();
  const focus = vi.fn();
  const select = vi.fn();
  const container = {
    querySelector: () => ({ focus, select }),
    contains: () => false,
  } as unknown as HTMLDivElement;
  class Editable {
    isContentEditable = true;
  }
  vi.stubGlobal("window", events);
  vi.stubGlobal("HTMLElement", Editable);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  function Probe() {
    useListSearchShortcut({
      condensed: false,
      inFlowSearchRef: { current: container },
      setSearchOpen: vi.fn(),
      setSearchFocusToken: vi.fn(),
    });
    return null;
  }
  let renderer: ReturnType<typeof create>;
  try {
    await act(() => {
      renderer = create(<Probe />);
    });
    const editorFind = new Event("keydown", { cancelable: true });
    Object.defineProperties(editorFind, {
      key: { value: "f" },
      ctrlKey: { value: true },
      target: { value: new Editable() },
    });
    events.dispatchEvent(editorFind);
    expect(editorFind.defaultPrevented).toBe(false);
    expect(focus).not.toHaveBeenCalled();

    const listFind = new Event("keydown", { cancelable: true });
    Object.defineProperties(listFind, { key: { value: "f" }, ctrlKey: { value: true } });
    events.dispatchEvent(listFind);
    expect(listFind.defaultPrevented).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
  } finally {
    await act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});
