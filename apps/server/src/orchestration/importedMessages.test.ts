import type { SessionMessage as ClaudeSessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mapClaudeSessionMessages, mapCodexThreadSnapshot } from "./importedMessages.ts";

const threadId = ThreadId.make("thread-import");
const importedAt = "2026-01-01T00:00:00.000Z";

const claudeMessage = (
  input: Pick<ClaudeSessionMessage, "type" | "uuid"> & { readonly message: unknown },
): ClaudeSessionMessage => ({
  type: input.type,
  uuid: input.uuid,
  session_id: "session-1",
  message: input.message,
  parent_tool_use_id: null,
});

describe("mapClaudeSessionMessages", () => {
  it("keeps user and assistant text and skips everything else", () => {
    const messages = mapClaudeSessionMessages({
      threadId,
      importedAt,
      messages: [
        claudeMessage({
          type: "user",
          uuid: "uuid-1",
          message: { role: "user", content: "Fix the flaky test" },
        }),
        claudeMessage({
          type: "system",
          uuid: "uuid-2",
          message: { role: "system", content: "compact boundary" },
        }),
        claudeMessage({
          type: "assistant",
          uuid: "uuid-3",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Looking at it" },
              { type: "tool_use", id: "tool-1", name: "Bash", input: {} },
              { type: "text", text: "Done" },
            ],
          },
        }),
        claudeMessage({
          type: "user",
          uuid: "uuid-4",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
          },
        }),
      ],
    });

    expect(messages).toEqual([
      {
        messageId: "imported:claudeAgent:thread-import:000000:uuid-1",
        role: "user",
        text: "Fix the flaky test",
        createdAt: importedAt,
        updatedAt: importedAt,
      },
      {
        messageId: "imported:claudeAgent:thread-import:000002:uuid-3",
        role: "assistant",
        text: "Looking at it\n\nDone",
        createdAt: importedAt,
        updatedAt: importedAt,
      },
    ]);
  });

  it("orders message ids so a transcript past ten messages still sorts chronologically", () => {
    const messages = mapClaudeSessionMessages({
      threadId,
      importedAt,
      messages: Array.from({ length: 12 }, (_, index) =>
        claudeMessage({
          type: "user",
          uuid: `uuid-${index}`,
          message: { role: "user", content: `message ${index}` },
        }),
      ),
    });

    const sortedByMessageId = [...messages].sort((left, right) =>
      left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0,
    );
    expect(sortedByMessageId.map((message) => message.text)).toEqual(
      messages.map((message) => message.text),
    );
  });

  it("derives the same message ids when the same transcript is imported again", () => {
    const messages = [
      claudeMessage({
        type: "user",
        uuid: "uuid-1",
        message: { role: "user", content: "First" },
      }),
      claudeMessage({
        type: "assistant",
        uuid: "uuid-2",
        message: { role: "assistant", content: "Second" },
      }),
    ];

    expect(mapClaudeSessionMessages({ threadId, importedAt, messages })).toEqual(
      mapClaudeSessionMessages({ threadId, importedAt, messages }),
    );
  });
});

describe("mapCodexThreadSnapshot", () => {
  it("keeps user and agent messages and skips empty text", () => {
    const messages = mapCodexThreadSnapshot({
      threadId,
      importedAt,
      snapshot: {
        threadId,
        turns: [
          {
            id: TurnId.make("turn-1"),
            items: [
              { type: "userMessage", id: "item-1", content: [{ type: "text", text: "Ship it" }] },
              { type: "reasoning", id: "item-2", summary: ["thinking"] },
              { type: "agentMessage", id: "item-3", text: "Shipped" },
            ],
          },
          {
            id: TurnId.make("turn-2"),
            items: [
              { type: "userMessage", id: "item-4", content: [{ type: "image", url: "x" }] },
              { type: "agentMessage", id: "item-5", text: "   " },
            ],
          },
        ],
      },
    });

    expect(messages).toEqual([
      {
        messageId: "imported:codex:thread-import:000000:item-1",
        role: "user",
        text: "Ship it",
        createdAt: importedAt,
        updatedAt: importedAt,
      },
      {
        messageId: "imported:codex:thread-import:000002:item-3",
        role: "assistant",
        text: "Shipped",
        createdAt: importedAt,
        updatedAt: importedAt,
      },
    ]);
  });
});
