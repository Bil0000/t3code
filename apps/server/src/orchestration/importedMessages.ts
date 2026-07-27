import type { SessionMessage as ClaudeSessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { MessageId, type ThreadId, type ThreadImportedMessage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ProviderThreadSnapshot } from "../provider/Services/ProviderAdapter.ts";

const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
const isTextPart = Schema.is(TextPart);

const ClaudeMessageBody = Schema.Struct({
  content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
});
const isClaudeMessageBody = Schema.is(ClaudeMessageBody);

const CodexUserMessageItem = Schema.Struct({
  type: Schema.Literal("userMessage"),
  id: Schema.String,
  content: Schema.Array(Schema.Unknown),
});
const isCodexUserMessageItem = Schema.is(CodexUserMessageItem);

const CodexAgentMessageItem = Schema.Struct({
  type: Schema.Literal("agentMessage"),
  id: Schema.String,
  text: Schema.String,
});
const isCodexAgentMessageItem = Schema.is(CodexAgentMessageItem);

const IMPORTED_MESSAGE_INDEX_DIGITS = 6;

interface ImportedTranscriptEntry {
  readonly role: ThreadImportedMessage["role"];
  readonly text: string;
  readonly sourceId: string;
}

function joinTextParts(parts: ReadonlyArray<unknown>): string {
  return parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

function toImportedMessages(input: {
  readonly threadId: ThreadId;
  readonly provider: string;
  readonly importedAt: string;
  readonly entries: ReadonlyArray<ImportedTranscriptEntry | null>;
}): ReadonlyArray<ThreadImportedMessage> {
  return input.entries.flatMap((entry, index) => {
    if (entry === null || entry.text.length === 0) {
      return [];
    }
    return [
      {
        messageId: MessageId.make(
          `imported:${input.provider}:${input.threadId}:${String(index).padStart(IMPORTED_MESSAGE_INDEX_DIGITS, "0")}:${entry.sourceId}`,
        ),
        role: entry.role,
        text: entry.text,
        createdAt: input.importedAt,
        updatedAt: input.importedAt,
      },
    ];
  });
}

function readClaudeEntry(message: ClaudeSessionMessage): ImportedTranscriptEntry | null {
  if (message.type !== "user" && message.type !== "assistant") {
    return null;
  }
  const body = message.message;
  if (!isClaudeMessageBody(body)) {
    return null;
  }
  return {
    role: message.type,
    text: typeof body.content === "string" ? body.content.trim() : joinTextParts(body.content),
    sourceId: message.uuid,
  };
}

function readCodexEntry(item: unknown): ImportedTranscriptEntry | null {
  if (isCodexUserMessageItem(item)) {
    return { role: "user", text: joinTextParts(item.content), sourceId: item.id };
  }
  if (isCodexAgentMessageItem(item)) {
    return { role: "assistant", text: item.text.trim(), sourceId: item.id };
  }
  return null;
}

export function mapClaudeSessionMessages(input: {
  readonly threadId: ThreadId;
  readonly importedAt: string;
  readonly messages: ReadonlyArray<ClaudeSessionMessage>;
}): ReadonlyArray<ThreadImportedMessage> {
  return toImportedMessages({
    threadId: input.threadId,
    provider: "claudeAgent",
    importedAt: input.importedAt,
    entries: input.messages.map(readClaudeEntry),
  });
}

export function mapCodexThreadSnapshot(input: {
  readonly threadId: ThreadId;
  readonly importedAt: string;
  readonly snapshot: ProviderThreadSnapshot;
}): ReadonlyArray<ThreadImportedMessage> {
  return toImportedMessages({
    threadId: input.threadId,
    provider: "codex",
    importedAt: input.importedAt,
    entries: input.snapshot.turns.flatMap((turn) => turn.items).map(readCodexEntry),
  });
}
