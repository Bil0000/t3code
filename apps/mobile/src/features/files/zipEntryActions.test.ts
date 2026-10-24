import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { loadZipArchive } from "@t3tools/client-runtime/zip-preview";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

const io = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  beforeCopy: null as (() => Promise<void>) | null,
  beforeCacheWrite: null as (() => Promise<void>) | null,
  onDelete: null as (() => void) | null,
}));

vi.mock("expo-crypto", async () => ({ randomUUID: (await import("node:crypto")).randomUUID }));
vi.mock("expo-file-system", () => {
  const uriOf = (parts: Array<string | { uri: string }>) =>
    parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
  class Directory {
    readonly uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = uriOf(parts);
    }
    exists = true;
    create() {}
    list() {
      return [];
    }
    delete() {
      for (const uri of io.files.keys()) {
        if (uri.startsWith(`${this.uri}/`)) io.files.delete(uri);
      }
    }
  }
  class File {
    static async downloadFileAsync(
      url: string,
      destination: File,
      options: { signal: AbortSignal },
    ) {
      options.signal.throwIfAborted();
      const bytes = io.files.get(url);
      if (!bytes) throw new Error(`Missing download: ${url}`);
      await destination.write(bytes);
      return destination;
    }
    readonly uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = uriOf(parts);
    }
    get exists() {
      return io.files.has(this.uri);
    }
    get size() {
      return io.files.get(this.uri)?.byteLength ?? null;
    }
    get parentDirectory() {
      return new Directory(this.uri.slice(0, this.uri.lastIndexOf("/")));
    }
    get name() {
      return this.uri.slice(this.uri.lastIndexOf("/") + 1);
    }
    create() {
      io.files.set(this.uri, new Uint8Array());
    }
    async write(value: string | Uint8Array) {
      if (this.uri.startsWith("file:///cache/")) await io.beforeCacheWrite?.();
      io.files.set(
        this.uri,
        typeof value === "string" ? new TextEncoder().encode(value) : value.slice(),
      );
    }
    async copy(destination: File) {
      await io.beforeCopy?.();
      const bytes = io.files.get(this.uri);
      if (!bytes) throw new Error(`Missing file: ${this.uri}`);
      io.files.set(destination.uri, bytes.slice());
    }
    moveSync(destination: File) {
      io.files.set(destination.uri, io.files.get(this.uri)!);
      io.files.delete(this.uri);
    }
    delete() {
      io.files.delete(this.uri);
      io.onDelete?.();
    }
    async text() {
      return new TextDecoder().decode(io.files.get(this.uri));
    }
  }
  return {
    Directory,
    File,
    FileMode: { ReadOnly: "r", WriteOnly: "w" },
    Paths: { document: { uri: "file:///documents" }, cache: { uri: "file:///cache" } },
  };
});

import type { DraftComposerFileAttachment } from "../../lib/composerImages";
import { downloadAttachmentForPreview } from "../../lib/attachmentDownload";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  questionAttachmentDraftKey,
  questionAttachmentDraftPrefix,
  questionAttachmentPreparationAtom,
} from "../../state/question-attachments";
import {
  clearComposerDraft,
  composerDraftsAtom,
  flushComposerDrafts,
  type ComposerDraft,
} from "../../state/use-composer-drafts";
import { addFileToDraft, addZipEntryToDraft } from "./zipEntryActions";

const attachment: DraftComposerFileAttachment = {
  id: "a",
  type: "file",
  name: "first.txt",
  mimeType: "text/plain",
  sizeBytes: 22,
  fileUri: "file:///documents/existing.txt",
};
const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const draftKey = "environment-1:thread-1";
const prefix = questionAttachmentDraftPrefix(environmentId, threadId);
const questionKey = (requestId: string, questionId: string) =>
  questionAttachmentDraftKey(environmentId, threadId, requestId, questionId);
const files = (count: number): ComposerDraft => ({
  text: "",
  attachments: Array.from({ length: count }, (_, index) => ({
    ...attachment,
    id: `existing-${index}`,
    fileUri: `file:///documents/existing-${index}.txt`,
  })),
});
const ownedFiles = () =>
  [...io.files.keys()].filter((uri) =>
    uri.startsWith("file:///documents/t3-composer-attachments/"),
  );
const cachedFiles = () =>
  [...io.files.keys()].filter((uri) => uri.startsWith("file:///cache/t3-attachment-downloads/"));

async function setup(
  drafts: Record<string, ComposerDraft>,
  kind: "ZIP entry" | "normal file",
  zipBase64?: string,
) {
  io.files.clear();
  io.beforeCopy = null;
  io.beforeCacheWrite = null;
  io.onDelete = null;
  appAtomRegistry.set(composerDraftsAtom, drafts);
  appAtomRegistry.set(questionAttachmentPreparationAtom, {});
  onTestFinished(async () => {
    await flushComposerDrafts();
    appAtomRegistry.set(composerDraftsAtom, {});
    appAtomRegistry.set(questionAttachmentPreparationAtom, {});
    io.beforeCopy = null;
    io.beforeCacheWrite = null;
    io.onDelete = null;
  });
  const bytes = Uint8Array.from(
    atob(
      zipBase64 ??
        "UEsDBBQAAAAAAAAAIVyzyFShFgAAABYAAAAJAAAAZmlyc3QudHh0Rmlyc3QgYXJjaGl2ZSBjb250ZW50c1BLAQIUAxQAAAAAAAAAIVyzyFShFgAAABYAAAAJAAAAAAAAAAAAAACAAQAAAABmaXJzdC50eHRQSwUGAAAAAAEAAQA3AAAAPQAAAAAA",
    ),
    (character) => character.charCodeAt(0),
  );
  const archive = await loadZipArchive(bytes, new AbortController().signal);
  const entry = archive.entries[0]!;
  const attachment = { name: entry.name, mimeType: entry.mimeType ?? "application/octet-stream" };
  const url = "https://files.example/first.txt";
  io.files.set(url, await archive.readFileForSave(entry, new AbortController().signal));
  return {
    archive,
    entry,
    maxBytes: 1024,
    add: (
      input: Omit<Parameters<typeof addFileToDraft>[0], "name" | "mimeType" | "sizeBytes" | "open">,
    ) =>
      kind === "ZIP entry"
        ? addZipEntryToDraft({ ...input, archive, entry })
        : addFileToDraft({
            ...input,
            ...attachment,
            sizeBytes: entry.sizeBytes,
            open: (signal) => downloadAttachmentForPreview({ url, attachment, signal }),
          }),
  };
}

it("rejects a known oversized file before opening it", async () => {
  const key = questionKey("request-1", "question-1");
  const drafts = { [key]: { text: "Keep this answer", attachments: [] } };
  await setup(drafts, "normal file");

  await expect(
    addFileToDraft({
      name: "large.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 2 * 1024 * 1024 * 1024,
      maxBytes: 64 * 1024 * 1024,
      draftKey: key,
      questionPrefix: prefix,
      signal: new AbortController().signal,
      open: async () => {
        throw new Error("File download started.");
      },
    }),
  ).rejects.toThrow("'large.bin' exceeds the 64 MB attachment limit.");

  expect(appAtomRegistry.get(composerDraftsAtom)).toEqual(drafts);
  expect(appAtomRegistry.get(questionAttachmentPreparationAtom)[key]).toBe(0);
  expect(ownedFiles()).toEqual([]);
  expect(cachedFiles()).toEqual([]);
});

describe.each(["ZIP entry", "normal file"] as const)("%s Add", (kind) => {
  it("rejects an already cancelled Add and leaves no pending question work", async () => {
    const key = questionKey("request-1", "question-1");
    const drafts = { [key]: { text: "Keep this answer", attachments: [] } };
    const source = await setup(drafts, kind);
    const controller = new AbortController();
    controller.abort();

    await expect(
      source.add({
        ...source,
        draftKey: key,
        questionPrefix: prefix,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(appAtomRegistry.get(composerDraftsAtom)).toEqual(drafts);
    expect(appAtomRegistry.get(questionAttachmentPreparationAtom)[key] ?? 0).toBe(0);
    expect(ownedFiles()).toEqual([]);
    expect(cachedFiles()).toEqual([]);
  });

  it.each(["open", "copy"] as const)(
    "does not change the draft and removes the copy when Back cancels during %s",
    async (stage) => {
      const drafts = { [draftKey]: { text: "Keep this draft", attachments: [] } };
      const source = await setup(drafts, kind);
      const controller = new AbortController();
      const copying = Promise.withResolvers<void>();
      const copied = Promise.withResolvers<void>();
      const pause = () => {
        copying.resolve();
        return copied.promise;
      };
      if (stage === "open") io.beforeCacheWrite = pause;
      else io.beforeCopy = pause;
      const adding = source.add({
        ...source,
        draftKey,
        questionPrefix: null,
        signal: controller.signal,
      });
      const rejected = expect(adding).rejects.toMatchObject({ name: "AbortError" });
      await copying.promise;
      controller.abort();
      copied.resolve();
      await rejected;

      expect(appAtomRegistry.get(composerDraftsAtom)).toEqual(drafts);
      expect(ownedFiles()).toEqual([]);
      expect(cachedFiles()).toEqual([]);
    },
  );

  it("allows 100 files across two questions, excludes other requests, and rejects file 101", async () => {
    const firstKey = questionKey("request-1", "question-1");
    const key = questionKey("request-1", "question-2");
    const otherKey = questionKey("request-2", "question-1");
    const drafts = {
      [firstKey]: files(60),
      [key]: files(39),
      [otherKey]: files(30),
      [draftKey]: files(5),
    };
    const source = await setup(drafts, kind);
    const input = {
      ...source,
      draftKey: key,
      questionPrefix: prefix,
      signal: new AbortController().signal,
    };
    await source.add(input);

    const full = appAtomRegistry.get(composerDraftsAtom);
    expect(full).toEqual({
      ...drafts,
      [key]: {
        text: "",
        attachments: [
          ...drafts[key]!.attachments,
          expect.objectContaining({ name: "first.txt", sizeBytes: 22 }),
        ],
      },
    });
    const retainedFiles = ownedFiles();
    const removed = Promise.withResolvers<void>();
    io.onDelete = () => removed.resolve();
    await expect(source.add(input)).rejects.toThrow(
      "This message already has as many attachments as it can hold.",
    );
    await removed.promise;

    expect(appAtomRegistry.get(composerDraftsAtom)).toEqual(full);
    expect(ownedFiles()).toEqual(retainedFiles);
    expect(cachedFiles()).toEqual([]);
    expect(appAtomRegistry.get(questionAttachmentPreparationAtom)[key]).toBe(0);
  });

  it.each(["open", "copy"] as const)(
    "does not recreate a question draft resolved on another client during %s",
    async (stage) => {
      const key = questionKey("request-1", "question-1");
      const otherKey = questionKey("request-2", "question-1");
      const retained = { [otherKey]: { text: "Keep this answer", attachments: [] } };
      const source = await setup(
        {
          ...retained,
          [key]: { text: "Answer in progress", attachments: [] },
        },
        kind,
      );
      const copying = Promise.withResolvers<void>();
      const copied = Promise.withResolvers<void>();
      const pause = () => {
        copying.resolve();
        return copied.promise;
      };
      if (stage === "open") io.beforeCacheWrite = pause;
      else io.beforeCopy = pause;
      const adding = source.add({
        ...source,
        draftKey: key,
        questionPrefix: prefix,
        signal: new AbortController().signal,
      });
      const rejected = expect(adding).rejects.toThrow("This question was already answered.");
      await copying.promise;
      const reserved = appAtomRegistry.get(questionAttachmentPreparationAtom)[key];
      clearComposerDraft(key);
      appAtomRegistry.set(questionAttachmentPreparationAtom, {});
      copied.resolve();
      await rejected;

      expect(reserved).toBe(1);
      expect(appAtomRegistry.get(composerDraftsAtom)).toEqual(retained);
      expect(ownedFiles()).toEqual([]);
      expect(cachedFiles()).toEqual([]);
      expect(appAtomRegistry.get(questionAttachmentPreparationAtom)).toEqual({});
    },
  );

  it("leaves the question unchanged and releases its reservation when the file exceeds the upload limit", async () => {
    const key = questionKey("request-1", "question-1");
    const drafts = { [key]: { text: "Keep this answer", attachments: [] } };
    const source = await setup(drafts, kind);

    await expect(
      source.add({
        ...source,
        maxBytes: 1,
        draftKey: key,
        questionPrefix: prefix,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("'first.txt' exceeds the 1 byte attachment limit.");

    expect(appAtomRegistry.get(composerDraftsAtom)).toEqual(drafts);
    expect(appAtomRegistry.get(questionAttachmentPreparationAtom)[key]).toBe(0);
    expect(ownedFiles()).toEqual([]);
    expect(cachedFiles()).toEqual([]);
  });

  it("adds a composer file with a context reference to its captured draft and preserves all bytes", async () => {
    const otherKey = "environment-1:thread-2";
    const otherDraft = { text: "Other thread", attachments: [] };
    const source = await setup(
      {
        [draftKey]: { text: "Review", attachments: [] },
        [otherKey]: otherDraft,
      },
      kind,
    );
    await source.add({
      ...source,
      draftKey,
      questionPrefix: null,
      signal: new AbortController().signal,
    });

    const draft = appAtomRegistry.get(composerDraftsAtom)[draftKey]!;
    const added = draft.attachments[0] as DraftComposerFileAttachment;
    expect(draft).toEqual({
      text: `Review [first.txt](t3-context://v1/file/${added.id}) `,
      attachments: [added],
      context: {
        version: 1,
        records: [
          {
            version: 1,
            contextId: added.id,
            kind: "file",
            label: "first.txt",
            attachmentId: added.id,
            name: "first.txt",
            mimeType: source.entry.mimeType ?? "application/octet-stream",
            sizeBytes: 22,
          },
        ],
      },
    });
    expect(added).toMatchObject({
      name: "first.txt",
      mimeType: source.entry.mimeType ?? "application/octet-stream",
      sizeBytes: 22,
    });
    expect(io.files.get(added.fileUri)).toEqual(new TextEncoder().encode("First archive contents"));
    expect(appAtomRegistry.get(composerDraftsAtom)[otherKey]).toEqual(otherDraft);
    expect(ownedFiles()).toEqual([added.fileUri]);
    expect(cachedFiles()).toEqual([]);
  });

  it("attaches every byte when the file is longer than its text preview", async () => {
    const source = await setup(
      { [draftKey]: { text: "Review", attachments: [] } },
      kind,
      "UEsDBBQAAAAIAHOqWF0hEuAxCgQAAAEAEAAJAAAAZmlyc3QudHh07cExAQAAAMKgbOtfyhC+QAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAnAZQSwECFAMUAAAACABzqlhdIRLgMQoEAAABABAACQAAAAAAAAAAAAAAgAEAAAAAZmlyc3QudHh0UEsFBgAAAAABAAEANwAAADEEAAAAAA==",
    );
    const signal = new AbortController().signal;
    const preview = await source.archive.readTextPrefix(source.entry, signal);
    expect(preview.truncated).toBe(true);
    expect(preview.bytes.byteLength).toBe(1024 * 1024);

    await source.add({
      ...source,
      maxBytes: 2 * 1024 * 1024,
      draftKey,
      questionPrefix: null,
      signal,
    });

    const added = appAtomRegistry.get(composerDraftsAtom)[draftKey]!
      .attachments[0] as DraftComposerFileAttachment;
    expect(added.sizeBytes).toBe(1024 * 1024 + 1);
    expect(io.files.get(added.fileUri)).toEqual(new Uint8Array(1024 * 1024 + 1).fill(65));
    expect(cachedFiles()).toEqual([]);
  });
});
