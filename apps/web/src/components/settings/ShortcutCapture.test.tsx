import { act, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ShortcutCapture } from "./ShortcutCapture";

vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));

function Recorder() {
  const [value, setValue] = useState("");
  const [recording, setRecording] = useState(true);
  return (
    <ShortcutCapture
      value={value}
      recording={recording}
      label="Next thread"
      onChange={setValue}
      onRecordingChange={setRecording}
    />
  );
}

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", { platform: "MacIntel" });
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("finishes mouse recording after suppressing the release and keeps the captured value", async () => {
  await act(() => {
    renderer = create(<Recorder />);
  });
  for (const type of ["mousedown", "mouseup", "auxclick"]) {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      button: 4,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
    await act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(renderer.root.findAllByType("input")).toHaveLength(type === "auxclick" ? 0 : 1);
  }
  expect(renderer.root.findByType("button").children).toEqual(["Mouse Forward"]);
});

it("finishes keyboard recording after one valid key", async () => {
  await act(() => {
    renderer = create(<Recorder />);
  });
  const input = {
    key: "k",
    code: "KeyK",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  };
  await act(() => {
    renderer.root.findByType("input").props.onKeyDown({
      ...input,
      nativeEvent: input,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
  });
  expect(renderer.root.findAllByType("input")).toHaveLength(0);
  expect(renderer.root.findByType("button").children).toEqual(["⌘K"]);
});
