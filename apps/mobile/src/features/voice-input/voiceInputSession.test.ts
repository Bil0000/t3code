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
      const starting = session.start(createVoiceInputTarget("first", () => "first", firstCommit));
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
      await session.start(createVoiceInputTarget("second", () => "second", secondCommit));
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
      await session.start(createVoiceInputTarget("first", () => text, commit));
      text = change === "removed" ? null : "edited prompt";
      await session.controller.stop();
      expect(commit).not.toHaveBeenCalled();
      expect(session.controller.currentState.error).toContain("draft changed");
    },
  );

  it("finishes the original draft at the recording limit while it is off screen", async () => {
    const { session, recorder } = createSession();
    const commit = vi.fn();
    await session.start(createVoiceInputTarget("first", () => "first", commit));
    await session.controller.handleRecorderStatus({
      isFinished: true,
      hasError: false,
      error: null,
      url: recorder.uri,
    });
    expect(commit).toHaveBeenCalledWith("first spoken text", { start: 17, end: 17 });
    expect(session.controller.currentState.phase).toBe("idle");
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
    const firstStart = session.start(createVoiceInputTarget("first", () => "first", oldCommit));
    await preparationEntered.promise;
    session.controller.cancel();
    const nextStart = session.start(createVoiceInputTarget("second", () => "second", nextCommit));
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
