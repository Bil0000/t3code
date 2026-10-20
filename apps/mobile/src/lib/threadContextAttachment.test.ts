import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const files = vi.hoisted(() => ({
  write: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  contents: vi.fn(),
}));
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
    name: string;
    parentDirectory: { uri: string };
    constructor(parent: { uri: string }, name: string) {
      this.uri = `${parent.uri}/${name}`;
      this.name = name;
      this.parentDirectory = parent;
    }
    create() {
      files.create(this.name);
    }
    write(text: string) {
      files.contents(text);
    }
    moveSync() {}
  },
  Paths: { document: { uri: "file:///documents" } },
}));
vi.mock("./atomic-file", () => ({ writeFileAtomically: files.write }));
vi.mock("./composerImages", () => ({ removePersistedComposerAttachmentFile: files.remove }));
vi.mock("./uuid", () => ({ uuidv4: () => "00000000-0000-4000-8000-000000000000" }));

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
      /^file:\/\/\/documents\/t3-composer-attachments\/00000000-0000-4000-8000-000000000000\.jsonl$/,
    );
    expect(JSON.parse(text.trim())).toMatchObject({
      title: transcript.title,
      environmentId: "remote",
      threadId: "thread",
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(attachment.threadTitle).toBe(transcript.title);
  });

  it("keeps final and atomic staging filenames within 255 bytes for long Unicode titles", async () => {
    const { writeFileAtomically } =
      await vi.importActual<typeof import("./atomic-file")>("./atomic-file");
    files.write.mockImplementationOnce(writeFileAtomically);
    const title = `${"界".repeat(64)} / original title`;
    const attachment = await threadContextAttachment(
      EnvironmentId.make("remote"),
      { ...transcript, title },
      4096,
    );
    const filename = attachment.fileUri.split("/").at(-1)!;
    const stagingFilename = files.create.mock.calls[0]![0];
    expect(new TextEncoder().encode(filename).byteLength).toBeLessThanOrEqual(255);
    expect(new TextEncoder().encode(stagingFilename).byteLength).toBeLessThanOrEqual(255);
    expect(stagingFilename).toMatch(/\.\d+\.tmp$/);
    expect(stagingFilename.startsWith(`${filename}.`)).toBe(true);
    expect(attachment.name).toMatch(new RegExp(`^${"界".repeat(64)}-.*\\.jsonl$`));
    expect(attachment.threadTitle).toBe(title);
    const text = files.contents.mock.calls[0]![0];
    expect(text).toBe(files.write.mock.calls[0]![1]);
    expect(JSON.parse(text.trim()).title).toBe(title);
    expect(attachment.sizeBytes).toBe(new TextEncoder().encode(text).byteLength);
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
