import type { EnvironmentId, OrchestrationV2ThreadTranscript } from "@t3tools/contracts";
import { threadTranscriptFile } from "@t3tools/shared/threadTranscript";

export function threadContextAttachment(
  environmentId: EnvironmentId,
  transcript: OrchestrationV2ThreadTranscript,
): File {
  const file = threadTranscriptFile(environmentId, transcript);
  return new File(file.parts, file.name, { type: file.mimeType });
}
