import { formatThreadContextLink } from "@t3tools/shared/threadContext";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "vite-plus/test";

import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import {
  ThreadManagementService,
  ThreadManagementThreadNotFoundError,
} from "../orchestration-v2/ThreadManagementService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import {
  layer as orchestratorMcpServiceLayer,
  OrchestratorMcpService,
} from "./OrchestratorMcpService.ts";

const environmentId = EnvironmentId.make("environment-mcp-orchestrator-detail");
const projectId = ProjectId.make("project-mcp-orchestrator-detail");
const parentThreadId = ThreadId.make("thread-mcp-orchestrator-parent");
const childThreadId = ThreadId.make("thread-mcp-orchestrator-child");
const activeRunId = RunId.make("run-mcp-active");
const cancelledRunId = RunId.make("run-mcp-cancelled");
const childRunId = RunId.make("run-mcp-child");
const taskId = NodeId.make("node-mcp-task-1");
const now = DateTime.makeUnsafe("2026-08-04T12:00:00.000Z");
const codexDriver = ProviderDriverKind.make("codex");
// Distinct from driver kind so a regression that re-derives from driver fails.
const customCodexInstanceId = ProviderInstanceId.make("codex-custom-workspace");
const parentInstanceId = ProviderInstanceId.make("codex");

const makeScope = (): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  threadId: parentThreadId,
  providerSessionId: "provider-session-mcp-orchestrator-detail",
  providerInstanceId: parentInstanceId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

function baseThread(input: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}) {
  return {
    id: input.threadId,
    projectId,
    title: input.title,
    createdBy: "user" as const,
    creationSource: "mcp" as const,
    modelSelection: {
      instanceId: input.instanceId,
      model: input.model,
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    archivedAt: null,
    deletedAt: null,
    providerInstanceId: input.instanceId,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRun(input: {
  readonly id: RunId;
  readonly ordinal: number;
  readonly status: "running" | "waiting" | "cancelled" | "queued" | "completed";
  readonly instanceId?: ProviderInstanceId;
}) {
  return {
    id: input.id,
    ordinal: input.ordinal,
    status: input.status,
    modelSelection: {
      instanceId: input.instanceId ?? parentInstanceId,
      model: "gpt-5.4",
    },
    providerInstanceId: input.instanceId ?? parentInstanceId,
    requestedAt: now,
    startedAt: input.status === "cancelled" || input.status === "queued" ? null : now,
    completedAt: input.status === "cancelled" || input.status === "completed" ? now : null,
  };
}

it("readThread prefers activity-run status over a newer cancelled queued run", async () => {
  const projection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [
      makeRun({ id: activeRunId, ordinal: 1, status: "running" }),
      makeRun({ id: cancelledRunId, ordinal: 2, status: "cancelled" }),
    ],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = orchestratorMcpServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) =>
            threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${threadId}`),
        } satisfies Partial<ThreadManagementService["Service"]>),
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry["Service"]>),
        Layer.mock(ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService;
    const result = yield* service.readThread(makeScope(), { threadId: parentThreadId });
    expect(result.thread.status).toBe("running");
    expect(result.thread.latestRunId).toBe(cancelledRunId);
    expect(result.thread.activeRunId).toBe(activeRunId);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("readThread prefers waiting activity status over a newer cancelled queued run", async () => {
  const projection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent waiting",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [
      makeRun({ id: activeRunId, ordinal: 1, status: "waiting" }),
      makeRun({ id: cancelledRunId, ordinal: 2, status: "cancelled" }),
    ],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = orchestratorMcpServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) =>
            threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${threadId}`),
        } satisfies Partial<ThreadManagementService["Service"]>),
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry["Service"]>),
        Layer.mock(ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService;
    const result = yield* service.readThread(makeScope(), { threadId: parentThreadId });
    expect(result.thread.status).toBe("waiting");
    expect(result.thread.activeRunId).toBe(activeRunId);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("taskStatus returns task.providerInstanceId rather than the driver kind", async () => {
  const parentProjection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [makeRun({ id: activeRunId, ordinal: 1, status: "running" })],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [
      {
        id: taskId,
        threadId: parentThreadId,
        runId: activeRunId,
        parentNodeId: NodeId.make("node-parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: codexDriver,
        providerInstanceId: customCodexInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Inspect the custom instance.",
        title: null,
        model: "gpt-5.4",
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const childProjection = {
    thread: {
      ...baseThread({
        threadId: childThreadId,
        title: "Child",
        instanceId: customCodexInstanceId,
        model: "gpt-5.4",
      }),
      lineage: {
        parentThreadId,
        relationshipToParent: "subagent",
        rootThreadId: parentThreadId,
      },
      createdBy: "agent",
    },
    runs: [
      makeRun({
        id: childRunId,
        ordinal: 1,
        status: "running",
        instanceId: customCodexInstanceId,
      }),
    ],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [
      {
        type: "subagent_spawn",
        sourceThreadId: parentThreadId,
        targetThreadId: childThreadId,
        targetRunId: childRunId,
      },
    ],
    subagents: [],
    providerThreads: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = orchestratorMcpServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) => {
            if (threadId === parentThreadId) return Effect.succeed(parentProjection);
            if (threadId === childThreadId) return Effect.succeed(childProjection);
            return Effect.die(`unexpected thread ${threadId}`);
          },
        } satisfies Partial<ThreadManagementService["Service"]>),
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry["Service"]>),
        Layer.mock(ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService;
    const result = yield* service.taskStatus(makeScope(), taskId);
    expect(result.providerInstanceId).toBe(customCodexInstanceId);
    expect(result.providerInstanceId).not.toBe(ProviderInstanceId.make(String(codexDriver)));
    expect(result.status).toBe("running");
    expect(result.taskId).toBe(taskId);
    expect(result.childThreadId).toBe(childThreadId);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("reads user-attached foreign threads in chunks without granting write access", async () => {
  const text = "Full thread context. ".repeat(4000);
  const target = {
    thread: {
      ...baseThread({
        threadId: childThreadId,
        title: "Attached",
        instanceId: parentInstanceId,
        model: "gpt-5.4",
      }),
      projectId: ProjectId.make("other-project"),
    },
    runs: [],
    runtimeRequests: [],
    messages: [
      {
        id: "message-context",
        role: "user",
        text: "See [logs](t3-context://v1/terminal/logs)",
        attachments: [
          {
            type: "file",
            id: "attachment-1",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 20,
          },
        ],
        context: {
          version: 1,
          records: [
            {
              version: 1,
              kind: "terminal",
              contextId: "logs",
              label: "logs",
              terminalId: "terminal-1",
              terminalLabel: "Build",
              lineStart: 1,
              lineEnd: 1,
              text: "Build passed",
            },
          ],
        },
      },
    ],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
    visibleTurnItems: [
      {
        position: 0,
        visibility: "local",
        sourceThreadId: childThreadId,
        sourceItemId: "item-1",
        item: {
          type: "assistant_message",
          text,
          messageId: "message-1",
          runId: null,
          status: "completed",
          title: null,
          updatedAt: now,
        },
      },
      {
        position: 1,
        visibility: "local",
        sourceThreadId: childThreadId,
        sourceItemId: "item-2",
        item: {
          type: "user_message",
          text: "See logs",
          messageId: "message-context",
          runId: null,
          status: "completed",
          title: null,
          updatedAt: now,
        },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const link = formatThreadContextLink({ environmentId, threadId: childThreadId }, "Attached");
  const parent = {
    ...target,
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    messages: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let author: "agent" | "user" = "agent";
  let attachedLink = link;
  const layer = orchestratorMcpServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) =>
            Effect.succeed(
              threadId === childThreadId
                ? target
                : {
                    ...parent,
                    messages: [
                      {
                        id: MessageId.make("attached-message"),
                        threadId: parentThreadId,
                        runId: null,
                        nodeId: null,
                        role: "user",
                        createdBy: author,
                        creationSource: "web",
                        text: attachedLink,
                        attachments: [],
                        streaming: false,
                        createdAt: now,
                        updatedAt: now,
                      },
                    ],
                  },
            ),
          getProjectThread: ({ projectId, threadId }) =>
            Effect.fail(new ThreadManagementThreadNotFoundError({ projectId, threadId })),
        }),
        Layer.mock(ProviderRegistry)({}),
        Layer.mock(ScheduledTaskService)({}),
        Layer.mock(ProviderAdapterRegistryV2)({}),
        NodeCrypto.layer,
      ),
    ),
  );
  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService;
    const read = () =>
      service.readThread(makeScope(), { threadId: childThreadId, limit: 1, maxCharsPerItem: 1000 });
    expect((yield* Effect.result(read()))._tag).toBe("Failure");
    author = "user";
    attachedLink = formatThreadContextLink(
      { environmentId: EnvironmentId.make("other-environment"), threadId: childThreadId },
      "Attached",
    );
    expect((yield* Effect.result(read()))._tag).toBe("Failure");
    attachedLink = link;
    const bounded = yield* service.readThread(makeScope(), { threadId: childThreadId });
    expect(bounded.items[0]?.nextTextOffset).toBe(4_000);
    expect(
      (yield* Effect.result(
        service.readThread(makeScope(), {
          threadId: childThreadId,
          environmentId: EnvironmentId.make("wrong-environment"),
        }),
      ))._tag,
    ).toBe("Failure");
    const first = yield* read();
    expect(first.thread.projectId).toBe("other-project");
    expect(first.items[0]?.nextTextOffset).toBe(1000);
    let reconstructed = "";
    let offset = 0;
    do {
      const page = yield* service.readThread(makeScope(), {
        threadId: childThreadId,
        itemPosition: 0,
        textOffset: offset,
        maxCharsPerItem: 1000,
      });
      const item = page.items[0]!;
      reconstructed += item.text?.replace(/\n…\[truncated\]$/, "");
      if (item.nextTextOffset == null) break;
      offset = item.nextTextOffset;
    } while (offset <= text.length);
    expect(reconstructed).toBe(text);
    const contextPage = yield* service.readThread(makeScope(), {
      threadId: childThreadId,
      itemPosition: 1,
    });
    expect(contextPage.items[0]?.text).toContain("1 | Build passed");
    expect(contextPage.items[0]?.text).toContain("notes.txt");
    const write = yield* Effect.result(
      service.sendToThread(makeScope(), { threadId: childThreadId, message: "Do not send" }),
    );
    expect(write._tag).toBe("Failure");
  }).pipe(Effect.provide(layer), Effect.runPromise);
});
