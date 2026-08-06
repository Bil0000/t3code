import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe } from "vite-plus/test";

import {
  buildImportedThreadEvents,
  importedMessageId,
  mapClaudeSessionMessages,
  parseCodexRollout,
} from "./SessionImportTranscript.ts";

const threadId = ThreadId.make("thread-import-test");
const fallbackAt = DateTime.makeUnsafe("2026-08-06T10:00:00.000Z");

describe("mapClaudeSessionMessages", () => {
  it("keeps only user/assistant text and drops synthetic context", () => {
    const entries = mapClaudeSessionMessages([
      { type: "user", uuid: "u1", message: { content: "  hello  " } },
      {
        type: "assistant",
        uuid: "a1",
        message: {
          content: [
            { type: "text", text: "hi" },
            { type: "tool_use", text: "x" },
          ],
        },
      },
      { type: "system", uuid: "s1", message: { content: "system" } },
      { type: "user", uuid: "u2", message: { content: [{ type: "tool_result" }] } },
      { type: "user", uuid: "u3", message: { content: "<system-reminder>noise" } },
    ]);
    assert.deepStrictEqual(
      entries.map((entry) => [entry.sourceId, entry.role, entry.text]),
      [
        ["u1", "user", "hello"],
        ["a1", "assistant", "hi"],
      ],
    );
  });
});

describe("parseCodexRollout", () => {
  it("reads session meta and both rollout item shapes", () => {
    const lines = [
      JSON.stringify({
        timestamp: "2026-08-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "t1", cwd: "/work/project" },
      }),
      JSON.stringify({
        timestamp: "2026-08-01T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          id: "m1",
          role: "user",
          content: [{ type: "input_text", text: "question" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-08-01T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "agent_message", id: "m2", message: "answer" },
      }),
      "not json",
      JSON.stringify({ type: "turn_context", payload: { cwd: "/elsewhere" } }),
    ].join("\n");
    const transcript = parseCodexRollout(lines);
    assert.strictEqual(transcript.workspaceRoot, "/work/project");
    assert.deepStrictEqual(
      transcript.entries.map((entry) => [entry.sourceId, entry.role, entry.text]),
      [
        ["m1", "user", "question"],
        ["m2", "assistant", "answer"],
      ],
    );
  });

  it("dedupes response_item/event_msg pairs sharing an id", () => {
    const lines = [
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", id: "m1", message: "question" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          id: "m1",
          role: "user",
          content: [{ type: "input_text", text: "question" }],
        },
      }),
    ].join("\n");
    assert.strictEqual(parseCodexRollout(lines).entries.length, 1);
  });
});

describe("buildImportedThreadEvents", () => {
  const entries = [
    {
      entry: { sourceId: "u1", role: "user" as const, text: "hello", timestamp: undefined },
      index: 0,
    },
    {
      entry: {
        sourceId: "a1",
        role: "assistant" as const,
        text: "hi",
        timestamp: "2026-08-02T00:00:00.000Z",
      },
      index: 1,
    },
  ];

  it("emits a deterministic message/turn-item pair per entry", () => {
    const batch = buildImportedThreadEvents({
      driver: "claudeAgent",
      providerDriver: ProviderDriverKind.make("claudeAgent"),
      threadId,
      entries,
      fallbackAt,
    });
    assert.strictEqual(batch.events.length, 4);
    assert.deepStrictEqual(
      batch.events.map((event) => event.type),
      ["message.updated", "turn-item.updated", "message.updated", "turn-item.updated"],
    );
    const again = buildImportedThreadEvents({
      driver: "claudeAgent",
      providerDriver: ProviderDriverKind.make("claudeAgent"),
      threadId,
      entries,
      fallbackAt,
    });
    assert.deepStrictEqual(
      again.events.map((event) => event.id),
      batch.events.map((event) => event.id),
    );
    assert.deepStrictEqual(
      batch.positions.map((position) => position.ordinal),
      [1, 2],
    );
  });

  it("uses the transcript timestamp when present and the fallback otherwise", () => {
    const batch = buildImportedThreadEvents({
      driver: "claudeAgent",
      providerDriver: ProviderDriverKind.make("claudeAgent"),
      threadId,
      entries,
      fallbackAt,
    });
    assert.strictEqual(DateTime.formatIso(batch.events[0]!.occurredAt), "2026-08-06T10:00:00.000Z");
    assert.strictEqual(DateTime.formatIso(batch.events[2]!.occurredAt), "2026-08-02T00:00:00.000Z");
  });

  it("derives stable message ids from driver, thread, index and source id", () => {
    assert.strictEqual(
      importedMessageId({ driver: "codex", threadId, index: 3, sourceId: "abc" }),
      `imported:codex:${threadId}:000003:abc`,
    );
  });
});
