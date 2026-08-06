import {
  EventId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export const SESSION_IMPORT_EVENT_PREFIX = "import:session";
const IMPORTED_MESSAGE_INDEX_DIGITS = 6;

export type ImportableSessionDriver = "claudeAgent" | "codex";

export function isImportableSessionDriver(driver: string): driver is ImportableSessionDriver {
  return driver === "claudeAgent" || driver === "codex";
}

/** One user/assistant text exchange read from a provider's on-disk transcript. */
export interface ImportedTranscriptEntry {
  /** Provider-native id of the source entry (Claude message uuid, Codex item id). */
  readonly sourceId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  /** ISO timestamp of the source entry when the transcript carries one. */
  readonly timestamp: string | undefined;
}

function joinTextParts(parts: ReadonlyArray<unknown>): string {
  return parts
    .flatMap((part) => {
      if (part === null || typeof part !== "object") return [];
      const record = part as { readonly type?: unknown; readonly text?: unknown };
      return (record.type === "text" ||
        record.type === "input_text" ||
        record.type === "output_text") &&
        typeof record.text === "string"
        ? [record.text]
        : [];
    })
    .join("\n\n")
    .trim();
}

function readMessageText(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const content = (body as { readonly content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (globalThis.Array.isArray(content)) return joinTextParts(content);
  return undefined;
}

/** Synthetic context blocks providers write into their transcripts as user turns. */
function isSyntheticContextText(text: string): boolean {
  return (
    text.startsWith("<environment_context>") ||
    text.startsWith("<user_instructions>") ||
    text.startsWith("<system-reminder>")
  );
}

/**
 * Maps messages returned by the Claude Agent SDK's `getSessionMessages` into
 * transcript entries. Only plain user/assistant text survives; tool calls,
 * tool results and any non-text content blocks are dropped.
 */
export function mapClaudeSessionMessages(
  messages: ReadonlyArray<{
    readonly type: string;
    readonly uuid: string;
    readonly message: unknown;
  }>,
): Array<ImportedTranscriptEntry> {
  return messages.flatMap((message) => {
    if (message.type !== "user" && message.type !== "assistant") return [];
    const text = readMessageText(message.message);
    if (text === undefined || text.length === 0 || isSyntheticContextText(text)) return [];
    return [{ sourceId: message.uuid, role: message.type, text, timestamp: undefined }];
  });
}

interface CodexRolloutLine {
  readonly timestamp?: unknown;
  readonly type?: unknown;
  readonly payload?: unknown;
}

export interface CodexRolloutTranscript {
  readonly workspaceRoot: string | null;
  readonly entries: ReadonlyArray<ImportedTranscriptEntry>;
}

/**
 * Parses a Codex rollout `.jsonl` transcript. Tolerant of the two shapes Codex
 * has used for conversation items (`response_item` messages and
 * `event_msg` user/agent messages); everything else is skipped.
 */
export function parseCodexRollout(content: string): CodexRolloutTranscript {
  let workspaceRoot: string | null = null;
  const entries: Array<ImportedTranscriptEntry> = [];
  const seenSourceIds = new Set<string>();

  const push = (entry: ImportedTranscriptEntry) => {
    if (entry.text.length === 0 || isSyntheticContextText(entry.text)) return;
    if (seenSourceIds.has(entry.sourceId)) return;
    seenSourceIds.add(entry.sourceId);
    entries.push(entry);
  };

  let index = 0;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    index += 1;
    let parsed: CodexRolloutLine;
    try {
      parsed = JSON.parse(line) as CodexRolloutLine;
    } catch {
      continue;
    }
    const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : undefined;
    const payload = parsed.payload;
    if (payload === null || typeof payload === "undefined" || typeof payload !== "object") {
      continue;
    }
    const record = payload as {
      readonly type?: unknown;
      readonly id?: unknown;
      readonly role?: unknown;
      readonly content?: unknown;
      readonly message?: unknown;
      readonly cwd?: unknown;
      readonly text?: unknown;
    };

    if (parsed.type === "session_meta" && typeof record.cwd === "string") {
      workspaceRoot = record.cwd.trim() || null;
      continue;
    }

    const sourceId =
      typeof record.id === "string" && record.id.length > 0 ? record.id : `line-${index}`;

    if (parsed.type === "response_item" && record.type === "message") {
      const role = record.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = globalThis.Array.isArray(record.content) ? joinTextParts(record.content) : "";
      push({ sourceId, role, text, timestamp });
      continue;
    }

    if (parsed.type === "event_msg") {
      if (record.type === "user_message" && typeof record.message === "string") {
        push({ sourceId, role: "user", text: record.message.trim(), timestamp });
      } else if (record.type === "agent_message" && typeof record.message === "string") {
        push({ sourceId, role: "assistant", text: record.message.trim(), timestamp });
      }
    }
  }

  return { workspaceRoot, entries };
}

export interface ImportedThreadEventBatch {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly positions: ReadonlyArray<{ readonly turnItemId: TurnItemId; readonly ordinal: number }>;
}

export function importedMessageId(input: {
  readonly driver: ImportableSessionDriver;
  readonly threadId: ThreadId;
  readonly index: number;
  readonly sourceId: string;
}): MessageId {
  return MessageId.make(
    `imported:${input.driver}:${input.threadId}:${String(input.index).padStart(IMPORTED_MESSAGE_INDEX_DIGITS, "0")}:${input.sourceId}`,
  );
}

export function importedMessageEventId(messageId: MessageId): EventId {
  return EventId.make(`${SESSION_IMPORT_EVENT_PREFIX}:message:${messageId}`);
}

/**
 * Builds the synthetic `message.updated` + `turn-item.updated` event pair for
 * each transcript entry, mirroring the legacy v1 transcript importer. Ids are
 * deterministic in (driver, threadId, transcript index, source id), so a
 * repeated import or sync pass cannot duplicate rows.
 */
export function buildImportedThreadEvents(input: {
  readonly driver: ImportableSessionDriver;
  readonly providerDriver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly entries: ReadonlyArray<{
    readonly entry: ImportedTranscriptEntry;
    readonly index: number;
  }>;
  readonly fallbackAt: DateTime.Utc;
}): ImportedThreadEventBatch {
  const events: Array<OrchestrationV2DomainEvent> = [];
  const positions: Array<{ readonly turnItemId: TurnItemId; readonly ordinal: number }> = [];
  for (const { entry, index } of input.entries) {
    const occurredAt =
      entry.timestamp === undefined
        ? input.fallbackAt
        : Option.getOrElse(DateTime.make(entry.timestamp), () => input.fallbackAt);
    const messageId = importedMessageId({
      driver: input.driver,
      threadId: input.threadId,
      index,
      sourceId: entry.sourceId,
    });
    const turnItemId = TurnItemId.make(`${SESSION_IMPORT_EVENT_PREFIX}:turn-item:${messageId}`);
    const message: OrchestrationV2ConversationMessage = {
      createdBy: entry.role === "user" ? "user" : "agent",
      creationSource: "server",
      id: messageId,
      threadId: input.threadId,
      runId: null,
      nodeId: null,
      role: entry.role,
      text: entry.text,
      attachments: [],
      streaming: false,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };
    const baseTurnItem = {
      id: turnItemId,
      threadId: input.threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: {
        driver: input.providerDriver,
        nativeId: entry.sourceId,
        strength: "weak" as const,
      },
      parentItemId: null,
      ordinal: index + 1,
      status: "completed" as const,
      title: null,
      startedAt: occurredAt,
      completedAt: occurredAt,
      updatedAt: occurredAt,
    };
    const turnItem: OrchestrationV2TurnItem =
      entry.role === "user"
        ? {
            ...baseTurnItem,
            createdBy: "user",
            creationSource: "server",
            type: "user_message",
            messageId,
            inputIntent: "turn_start",
            text: entry.text,
            attachments: [],
          }
        : {
            ...baseTurnItem,
            type: "assistant_message",
            messageId,
            text: entry.text,
            streaming: false,
          };
    events.push(
      {
        id: importedMessageEventId(messageId),
        type: "message.updated",
        threadId: input.threadId,
        occurredAt,
        payload: message,
      },
      {
        id: EventId.make(`${SESSION_IMPORT_EVENT_PREFIX}:turn-item:${messageId}`),
        type: "turn-item.updated",
        threadId: input.threadId,
        occurredAt,
        payload: turnItem,
      },
    );
    positions.push({ turnItemId, ordinal: index + 1 });
  }
  return { events, positions };
}
