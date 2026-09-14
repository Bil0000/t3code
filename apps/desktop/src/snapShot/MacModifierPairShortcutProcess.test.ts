import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

const { spawnedPollers } = vi.hoisted(() => ({
  spawnedPollers: [] as Array<{
    command: string;
    args: ReadonlyArray<string>;
    kill: ReturnType<typeof vi.fn>;
    emitStderr: (text: string) => void;
    emitExit: (code: number) => void;
  }>,
}));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: ReadonlyArray<string>) => {
    const stderrListeners: Array<(chunk: Buffer) => void> = [];
    const onceListeners = new Map<string, Array<(value?: unknown) => void>>();
    const record = {
      command,
      args,
      kill: vi.fn(() => true),
      emitStderr: (text: string) => {
        for (const listener of stderrListeners) listener(Buffer.from(text));
      },
      emitExit: (code: number) => {
        for (const listener of onceListeners.get("exit") ?? []) listener(code);
      },
    };
    spawnedPollers.push(record);
    const child = {
      stderr: {
        on: (_event: "data", listener: (chunk: Buffer) => void) => {
          stderrListeners.push(listener);
          return child;
        },
      },
      once: (event: string, listener: (value?: unknown) => void) => {
        onceListeners.set(event, [...(onceListeners.get(event) ?? []), listener]);
        return child;
      },
      kill: record.kill,
    };
    return child;
  },
}));

import { startMacModifierPairShortcutProcess } from "./MacModifierPairShortcutProcess.ts";

describe("macOS modifier pair poller", () => {
  it("resolves on ready, triggers on lines, and kills on stop", async () => {
    spawnedPollers.length = 0;
    const onTrigger = vi.fn();
    const onFailure = vi.fn();
    const started = startMacModifierPairShortcutProcess(
      [["MetaLeft", "MetaRight"]],
      onTrigger,
      onFailure,
    );
    const poller = spawnedPollers[0]!;
    expect(poller.command).toBe("/usr/bin/osascript");
    expect(poller.args.slice(-1)).toEqual(["[24]"]);

    poller.emitStderr("ready\ntrig");
    const stop = await started;
    poller.emitStderr("ger\ntrigger\n");
    expect(onTrigger).toHaveBeenCalledTimes(2);

    stop();
    expect(poller.kill).toHaveBeenCalledOnce();
    poller.emitStderr("trigger\n");
    expect(onTrigger).toHaveBeenCalledTimes(2);
    poller.emitExit(0);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("reports an unexpected exit after startup", async () => {
    spawnedPollers.length = 0;
    const onFailure = vi.fn();
    const started = startMacModifierPairShortcutProcess(
      [["ShiftLeft", "ShiftRight"]],
      () => undefined,
      onFailure,
    );
    const poller = spawnedPollers[0]!;
    poller.emitStderr("ready\n");
    await started;

    poller.emitExit(1);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("rejects when the poller dies before it is ready", async () => {
    spawnedPollers.length = 0;
    const started = startMacModifierPairShortcutProcess(
      [["ControlLeft", "ControlRight"]],
      () => undefined,
      () => undefined,
    );
    spawnedPollers[0]!.emitExit(1);
    await expect(started).rejects.toThrow(/exited with code 1/);
  });
});

it("uses distinct masks for mixed keys and shares one poller across shortcuts", async () => {
  spawnedPollers.length = 0;
  const started = startMacModifierPairShortcutProcess(
    [
      ["MetaLeft", "MetaRight"],
      ["MetaLeft", "ControlRight"],
      ["MetaRight", "ControlLeft"],
    ],
    () => undefined,
    () => undefined,
  );
  expect(spawnedPollers).toHaveLength(1);
  expect(JSON.parse(spawnedPollers[0]!.args.at(-1)!)).toEqual([24, 8200, 17]);
  spawnedPollers[0]!.emitStderr("ready\n");
  (await started)();
});

it("matches the recorded macOS key sides and fires once while held", async () => {
  spawnedPollers.length = 0;
  const started = startMacModifierPairShortcutProcess(
    [
      ["MetaLeft", "MetaRight"],
      ["MetaLeft", "ControlRight"],
    ],
    () => undefined,
    () => undefined,
  );
  const poller = spawnedPollers[0]!;
  const flags = [0x9, 0x2010, 0x2008, 0x2008, 0, 0x18, 0x18];
  const log = vi.fn();
  let index = 0;
  const context = {
    ObjC: { import: () => undefined },
    $: {
      getppid: () => (index < flags.length ? 2 : 1),
      CGEventSourceFlagsState: () => flags[index],
    },
    console: { log },
    delay: () => {
      index++;
    },
    args: [poller.args.at(-1)!],
  };
  NodeVM.runInNewContext(`${poller.args[3]}; run(args);`, context);
  expect(log.mock.calls).toEqual([["ready"], ["trigger"], ["trigger"]]);
  poller.emitStderr("ready\n");
  (await started)();
});
