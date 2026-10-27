import {
  EventId,
  MessageId,
  OrchestrationV2RpcSchemas,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import { describe, expect, it } from "vite-plus/test";

import { projectDomainEventForWire } from "./WireProjection.ts";
import { coalesceLiveUpdatedEvents } from "./ThreadLiveEventCoalescer.ts";

const OUTPUT_BYTES_PER_ROW = 8_192;
const NOW = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const THREAD_ID = ThreadId.make("thread-perf");

const PRE_OMISSION_COMMAND_EVENT_RPC_JSON_BYTES = 8_790;
const MAX_PROJECTED_COMMAND_EVENT_RPC_JSON_BYTES = 1_024;

const encodeThreadStreamItem = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2RpcSchemas.subscribeThread.output),
);

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function encodedThreadStreamChunkBytes(
  value: OrchestrationV2ThreadStreamItem,
  ...values: ReadonlyArray<OrchestrationV2ThreadStreamItem>
): number {
  const response = {
    _tag: "Chunk",
    requestId: 0,
    values: [encodeThreadStreamItem(value), ...values.map((item) => encodeThreadStreamItem(item))],
  } satisfies RpcMessage.ResponseChunkEncoded;
  return encodedBytes(response);
}

function makeCommandItem(index: number): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(`item-${index}`),
    type: "command_execution",
    threadId: THREAD_ID,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: index + 1,
    status: "completed",
    title: `Command ${index}`,
    input: `cmd-${index}`,
    output: "x".repeat(OUTPUT_BYTES_PER_ROW),
    exitCode: 0,
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
  };
}

function makeTurnItemEvent(item: OrchestrationV2TurnItem): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-${item.id}`),
    type: "turn-item.updated",
    threadId: THREAD_ID,
    occurredAt: NOW,
    payload: item,
  };
}

describe("thread transport payload budget", () => {
  it("sends only the newest growing message when coalescing a reconnect replay", () => {
    const replay = Array.from({ length: 64 }, (_, index) => {
      const sequence = index + 1;
      return {
        kind: "event",
        sequence,
        event: {
          id: EventId.make(`event-${sequence}`),
          type: "message.updated",
          threadId: THREAD_ID,
          occurredAt: NOW,
          payload: {
            id: MessageId.make("message-perf"),
            threadId: THREAD_ID,
            runId: null,
            nodeId: null,
            createdBy: "agent",
            creationSource: "provider",
            role: "assistant",
            text: "x".repeat(sequence * 256),
            attachments: [],
            streaming: true,
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      } satisfies Extract<OrchestrationV2ThreadStreamItem, { readonly kind: "event" }>;
    });
    const coalesced = coalesceLiveUpdatedEvents(replay);
    const beforeBytes = encodedThreadStreamChunkBytes(replay[0]!, ...replay.slice(1));
    const afterBytes = encodedThreadStreamChunkBytes(coalesced[0]!, ...coalesced.slice(1));

    expect(coalesced).toEqual([replay.at(-1)]);
    expect(coalesced[0]?.sequence).toBe(64);
    expect(beforeBytes).toBe(559_383);
    expect(afterBytes).toBe(16_845);
    expect(afterBytes / beforeBytes).toBeLessThan(0.04);
  });

  it("omits command output from a live event without changing persisted source data", () => {
    const sourceItem = makeCommandItem(0);
    const sourceEvent = makeTurnItemEvent(sourceItem);
    const projectedEvent = projectDomainEventForWire(sourceEvent);
    const preOmissionStreamItem: OrchestrationV2ThreadStreamItem = {
      kind: "event",
      sequence: 1,
      event: sourceEvent,
    };
    const projectedStreamItem: OrchestrationV2ThreadStreamItem = {
      kind: "event",
      sequence: 1,
      event: projectedEvent,
    };

    const preOmissionRpcJsonBytes = encodedThreadStreamChunkBytes(preOmissionStreamItem);
    const projectedRpcJsonBytes = encodedThreadStreamChunkBytes(projectedStreamItem);

    expect(preOmissionRpcJsonBytes).toBe(PRE_OMISSION_COMMAND_EVENT_RPC_JSON_BYTES);
    expect(projectedRpcJsonBytes).toBeLessThanOrEqual(MAX_PROJECTED_COMMAND_EVENT_RPC_JSON_BYTES);
    expect(projectedRpcJsonBytes / preOmissionRpcJsonBytes).toBeLessThanOrEqual(0.1);
    expect(sourceItem).toHaveProperty("output", "x".repeat(OUTPUT_BYTES_PER_ROW));
    expect(projectedEvent.payload).not.toHaveProperty("output");
  });
});
