import type { ZipPreviewEntry } from "@t3tools/client-runtime/zip-preview";
import { fileAttachmentTooLargeMessage } from "@t3tools/client-runtime/state/attachments";

import {
  writeGeneratedAttachmentFile,
  type AttachmentPreviewFile,
} from "../../lib/attachmentDownload";
import {
  createComposerFileAttachment,
  removePersistedComposerAttachmentFile,
} from "../../lib/composerImages";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  changeQuestionAttachmentPreparation,
  questionAttachmentCapacity,
  questionAttachmentPreparationAtom,
} from "../../state/question-attachments";
import {
  appendComposerDraftAttachments,
  composerDraftsAtom,
} from "../../state/use-composer-drafts";

interface ZipEntrySource {
  readonly readFileForSave: (entry: ZipPreviewEntry, signal: AbortSignal) => Promise<Uint8Array>;
}

async function extractZipEntry(
  archive: ZipEntrySource,
  entry: ZipPreviewEntry,
  signal: AbortSignal,
) {
  const bytes = await archive.readFileForSave(entry, signal);
  signal.throwIfAborted();
  return writeGeneratedAttachmentFile({
    bytes,
    attachment: { name: entry.name, mimeType: entry.mimeType ?? "application/octet-stream" },
  });
}

export async function withExtractedZipEntry(
  archive: ZipEntrySource,
  entry: ZipPreviewEntry,
  signal: AbortSignal,
  use: (file: { readonly uri: string; readonly share: () => Promise<void> }) => Promise<void>,
): Promise<void> {
  const file = await extractZipEntry(archive, entry, signal);
  try {
    signal.throwIfAborted();
    await use({ uri: file.uri, share: () => file.share(signal) });
  } finally {
    file.dispose();
  }
}

export async function addFileToDraft(input: {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
  readonly draftKey: string;
  readonly questionPrefix: string | null;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
  readonly open: (signal: AbortSignal) => Promise<AttachmentPreviewFile | null>;
}): Promise<void> {
  const { signal, draftKey, questionPrefix } = input;
  if (questionPrefix !== null) changeQuestionAttachmentPreparation(draftKey, 1);
  try {
    signal.throwIfAborted();
    if (input.sizeBytes !== null && input.sizeBytes > input.maxBytes) {
      throw new Error(fileAttachmentTooLargeMessage(input.name, input.maxBytes));
    }
    const file = await input.open(signal);
    if (file === null) {
      signal.throwIfAborted();
      throw new Error("Could not prepare this file.");
    }
    try {
      signal.throwIfAborted();
      const attachment = await createComposerFileAttachment({
        uri: file.uri,
        name: input.name,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        maxBytes: input.maxBytes,
      });
      const resolved =
        questionPrefix !== null &&
        (appAtomRegistry.get(questionAttachmentPreparationAtom)[draftKey] ?? 0) === 0;
      if (signal.aborted || resolved) {
        await removePersistedComposerAttachmentFile(attachment.fileUri);
        signal.throwIfAborted();
        throw new Error("This question was already answered.");
      }
      const rejected = appendComposerDraftAttachments(
        draftKey,
        [attachment],
        questionPrefix === null
          ? { appendReference: true }
          : {
              maxAttachments: questionAttachmentCapacity(
                appAtomRegistry.get(composerDraftsAtom),
                questionPrefix,
                draftKey,
              ),
            },
      );
      if (rejected) {
        throw new Error("This message already has as many attachments as it can hold.");
      }
    } finally {
      file.dispose();
    }
  } finally {
    if (questionPrefix !== null) changeQuestionAttachmentPreparation(draftKey, -1);
  }
}

export async function addZipEntryToDraft(input: {
  readonly archive: ZipEntrySource;
  readonly entry: ZipPreviewEntry;
  readonly draftKey: string;
  readonly questionPrefix: string | null;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}): Promise<void> {
  await addFileToDraft({
    ...input,
    name: input.entry.name,
    mimeType: input.entry.mimeType ?? "application/octet-stream",
    sizeBytes: input.entry.sizeBytes,
    open: (signal) => extractZipEntry(input.archive, input.entry, signal),
  });
}
