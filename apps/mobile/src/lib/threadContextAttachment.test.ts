import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const files = vi.hoisted(() => ({ write: vi.fn(), remove: vi.fn() }));
vi.mock("expo-file-system", () => ({
  Directory: class {
    uri: string;
    constructor(parent: { uri: string }, name: string) {
      this.uri = `${parent.uri}/${name}`;
    }
    create() {}
  },
  File: class {
    uri: string;
    constructor(parent: { uri: string }, name: string) {
      this.uri = `${parent.uri}/${name}`;
    }
  },
  Paths: { document: { uri: "file:///documents" } },
}));
vi.mock("./atomic-file", () => ({ writeFileAtomically: files.write }));
vi.mock("./composerImages", () => ({ removePersistedComposerAttachmentFile: files.remove }));
vi.mock("./uuid", () => ({ uuidv4: () => "file-id" }));

import { threadContextAttachment } from "./threadContextAttachment";

const transcript = {
  threadId: ThreadId.make("thread"),
  title: "Remote / 界 notes",
  updatedAt: DateTime.makeUnsafe("2026-10-20T00:00:00Z"),
  items: [],
};

describe("mobile thread transcript attachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes a UTF-8 JSONL file to the owned attachment directory", async () => {
    const attachment = await threadContextAttachment(
      EnvironmentId.make("remote"),
      transcript,
      4096,
    );
    const [file, text] = files.write.mock.calls[0]!;
    expect(attachment).toMatchObject({
      type: "file",
      mimeType: "application/x-ndjson",
      fileUri: file.uri,
      sizeBytes: new TextEncoder().encode(text).byteLength,
    });
    expect(attachment.fileUri).toMatch(
      /^file:\/\/\/documents\/t3-composer-attachments\/file-id-Remote _ 界 notes-.*\.jsonl$/,
    );
    expect(JSON.parse(text.trim())).toMatchObject({
      title: transcript.title,
      environmentId: "remote",
      threadId: "thread",
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(attachment).not.toHaveProperty("source");
  });

  it("rejects a file above the destination limit before writing", async () => {
    await expect(
      threadContextAttachment(EnvironmentId.make("remote"), transcript, 1),
    ).rejects.toThrow();
    expect(files.write).not.toHaveBeenCalled();
  });

  it("cleans up its file if writing fails", async () => {
    files.write.mockRejectedValueOnce(new Error("Disk full"));
    await expect(
      threadContextAttachment(EnvironmentId.make("remote"), transcript, 4096),
    ).rejects.toThrow("Disk full");
    expect(files.remove).toHaveBeenCalledWith(files.write.mock.calls[0]![0].uri);
  });
});
