import type { EnvironmentId, OrchestrationV2ThreadTranscript } from "@t3tools/contracts";
import { fileAttachmentTooLargeMessage } from "@t3tools/client-runtime/state/attachments";
import { threadTranscriptFile } from "@t3tools/shared/threadTranscript";
import { COMPOSER_ATTACHMENT_DIRECTORY } from "./composerAttachmentFiles";
import {
  removePersistedComposerAttachmentFile,
  type DraftComposerFileAttachment,
} from "./composerImages";
import { writeFileAtomically } from "./atomic-file";
import { uuidv4 } from "./uuid";

export async function threadContextAttachment(
  environmentId: EnvironmentId,
  transcript: OrchestrationV2ThreadTranscript,
  maxBytes: number,
): Promise<DraftComposerFileAttachment> {
  const transcriptFile = threadTranscriptFile(environmentId, transcript);
  const text = transcriptFile.parts.join("");
  const sizeBytes = new TextEncoder().encode(text).byteLength;
  if (sizeBytes > maxBytes)
    throw new Error(fileAttachmentTooLargeMessage(transcriptFile.name, maxBytes));
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, COMPOSER_ATTACHMENT_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, `${uuidv4()}-thread.jsonl`);
  try {
    await writeFileAtomically(file, text);
    return {
      id: uuidv4(),
      type: "file",
      name: transcriptFile.name,
      mimeType: transcriptFile.mimeType,
      threadTitle: transcriptFile.threadTitle,
      sizeBytes,
      fileUri: file.uri,
    };
  } catch (error) {
    await removePersistedComposerAttachmentFile(file.uri);
    throw error;
  }
}
