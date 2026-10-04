import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PreparedVoiceTranscription } from "@t3tools/client-runtime/voice-input";
import { resetVoiceInputGlobalsForTests } from "../../../../../packages/client-runtime/src/voice-input/controller";

import { createVoiceInputTarget, VoiceInputSession } from "./voiceInputSession";

function createSession() {
  const recorder = {
    uri: "file:///voice.m4a",
    prepareToRecordAsync: vi.fn(async () => {}),
    record: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const prepare = vi.fn(async (): Promise<PreparedVoiceTranscription> => ({
    locale: "en-US",
    transcribe: async () => "spoken text",
  }));
  const session = new VoiceInputSession({
    recorder,
    getTranscriber: () => ({ prepare }),
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => {},
    releaseRecording: vi.fn(async () => {}),
    deleteRecording: vi.fn(),
    onStateChange: vi.fn(),
  });
  return { session, recorder, prepare };
}

describe("global voice input", () => {
  beforeEach(() => resetVoiceInputGlobalsForTests());

  it.each([
    { selection: { start: 6, end: 11 }, expected: "hello spoken text", cursor: 17 },
    { selection: { start: 6, end: 6 }, expected: "hello spoken text world", cursor: 18 },
  ])(
    "keeps the starting selection $selection after navigation",
    async ({ selection, expected, cursor }) => {
      const { session } = createSession();
      const commit = vi.fn();
      await session.start(createVoiceInputTarget("first", () => "hello world", commit, selection));
      await session.start(
        createVoiceInputTarget("second", () => "other prompt", vi.fn(), { start: 12, end: 12 }),
      );
      await session.controller.stop();
      expect(commit).toHaveBeenCalledWith(expected, {
        start: cursor,
        end: cursor,
      });
    },
  );

  it("appends to the starting draft after its screen leaves and another draft opens", async () => {
    const { session, recorder } = createSession();
    const drafts = new Map([
      ["first", "original prompt"],
      ["second", "other prompt"],
    ]);
    let visibleDraft = "first";
    const targetKey = visibleDraft;
    await session.start(
      createVoiceInputTarget(
        targetKey,
        () => drafts.get(targetKey) ?? null,
        (text) => drafts.set(targetKey, text),
        { start: 15, end: 15 },
      ),
    );
    visibleDraft = "second";
    expect(session.controller.currentState.phase).toBe("recording");
    expect(recorder.stop).not.toHaveBeenCalled();
    await session.controller.stop();

    expect(drafts.get("first")).toBe("original prompt spoken text");
    expect(drafts.get(visibleDraft)).toBe("other prompt");
    expect(session.controller.currentState.phase).toBe("idle");
  });

  it.each(["preparing", "recording", "transcribing"] as const)(
    "keeps one recorder and its original target during %s",
    async (phase) => {
      const preparation = Promise.withResolvers<PreparedVoiceTranscription>();
      const preparationEntered = Promise.withResolvers<void>();
      const transcription = Promise.withResolvers<string>();
      const transcriptionEntered = Promise.withResolvers<void>();
      const { session, recorder, prepare } = createSession();
      prepare.mockImplementationOnce(() => {
        preparationEntered.resolve();
        return preparation.promise;
      });
      const firstCommit = vi.fn();
      const secondCommit = vi.fn();
      const starting = session.start(
        createVoiceInputTarget("first", () => "first", firstCommit, { start: 5, end: 5 }),
      );
      await preparationEntered.promise;
      let stopping: Promise<void> | null = null;
      if (phase !== "preparing") {
        preparation.resolve({
          locale: "en-US",
          transcribe: () => {
            transcriptionEntered.resolve();
            return transcription.promise;
          },
        });
        await starting;
      }
      if (phase === "transcribing") {
        stopping = session.controller.stop();
        await transcriptionEntered.promise;
      }
      await session.start(
        createVoiceInputTarget("second", () => "second", secondCommit, { start: 6, end: 6 }),
      );
      expect(session.ownerKey).toBe("first");
      expect(session.controller.currentState.phase).toBe(phase);
      expect(prepare).toHaveBeenCalledTimes(1);
      preparation.resolve({ locale: "en-US", transcribe: async () => "spoken text" });
      await starting;
      transcription.resolve("spoken text");
      await (stopping ?? session.controller.stop());
      expect(recorder.record).toHaveBeenCalledTimes(1);
      expect(firstCommit).toHaveBeenCalledWith("first spoken text", { start: 17, end: 17 });
      expect(secondCommit).not.toHaveBeenCalled();
    },
  );

  it.each(["changed", "removed"] as const)(
    "does not overwrite a %s starting draft",
    async (change) => {
      const { session } = createSession();
      let text: string | null = "first";
      const commit = vi.fn();
      await session.start(
        createVoiceInputTarget("first", () => text, commit, { start: 5, end: 5 }),
      );
      text = change === "removed" ? null : "edited prompt";
      await session.controller.stop();
      expect(commit).not.toHaveBeenCalled();
      expect(session.controller.currentState.error).toContain("draft changed");
    },
  );

  it("finishes the original draft at the recording limit while it is off screen", async () => {
    const { session, recorder } = createSession();
    const commit = vi.fn();
    await session.start(
      createVoiceInputTarget("first", () => "first", commit, { start: 5, end: 5 }),
    );
    await session.controller.handleRecorderStatus({
      isFinished: true,
      hasError: false,
      error: null,
      url: recorder.uri,
    });
    expect(commit).toHaveBeenCalledWith("first spoken text", { start: 17, end: 17 });
    expect(session.controller.currentState.phase).toBe("idle");
  });

  it("stops recording when its queued edit is discarded", async () => {
    const { session, recorder } = createSession();
    const commit = vi.fn();
    let draft: string | null = "queued prompt";
    const ownerKey = "thread~queued-edit~run";
    await session.start(
      createVoiceInputTarget(ownerKey, () => draft, commit, { start: 13, end: 13 }),
    );
    session.cancel(ownerKey);
    draft = null;
    await session.controller.stop();
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(session.controller.currentState).toEqual({
      phase: "idle",
      error: null,
      errorAction: null,
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it("keeps another prompt's recording when a queued edit is discarded", async () => {
    const { session, recorder } = createSession();
    const commit = vi.fn();
    await session.start(
      createVoiceInputTarget("other prompt", () => "hello", commit, { start: 5, end: 5 }),
    );
    session.cancel("thread~queued-edit~run");
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(session.controller.currentState.phase).toBe("recording");
    await session.controller.stop();
    expect(commit).toHaveBeenCalledWith("hello spoken text", { start: 17, end: 17 });
  });

  it("waits for canceled native work before starting a recording for another draft", async () => {
    const preparation = Promise.withResolvers<PreparedVoiceTranscription>();
    const preparationEntered = Promise.withResolvers<void>();
    const { session, recorder, prepare } = createSession();
    prepare.mockImplementationOnce(() => {
      preparationEntered.resolve();
      return preparation.promise;
    });
    const oldCommit = vi.fn();
    const nextCommit = vi.fn();
    const firstStart = session.start(
      createVoiceInputTarget("first", () => "first", oldCommit, { start: 5, end: 5 }),
    );
    await preparationEntered.promise;
    session.cancel("first");
    const nextStart = session.start(
      createVoiceInputTarget("second", () => "second", nextCommit, { start: 6, end: 6 }),
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(recorder.record).not.toHaveBeenCalled();
    preparation.resolve({ locale: "en-US", transcribe: async () => "old transcript" });
    await firstStart;
    await nextStart;
    await session.controller.stop();
    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(oldCommit).not.toHaveBeenCalled();
    expect(nextCommit).toHaveBeenCalledWith("second spoken text", { start: 18, end: 18 });
  });
});
