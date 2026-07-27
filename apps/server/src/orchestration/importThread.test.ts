import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationProject,
  type ProviderSession,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import { makeImportThread } from "./importThread.ts";

const projectId = ProjectId.make("project-1");
const workspaceRoot = "/home/dev/app";
const codexInstanceId = ProviderInstanceId.make("codex");
const cursorInstanceId = ProviderInstanceId.make("cursor");
const codexModelSelection = { instanceId: codexInstanceId, model: "gpt-5-codex" };
const lastActivityAtMs = 1767225600000;

const project: OrchestrationProject = {
  id: projectId,
  title: "App",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const codexSession: ProviderSession = {
  threadId: ThreadId.make("unused"),
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: codexInstanceId,
  status: "ready",
  runtimeMode: "full-access",
  cwd: workspaceRoot,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const codexTranscript = [
  { type: "userMessage", id: "item-1", content: [{ type: "text", text: "Ship it" }] },
  { type: "agentMessage", id: "item-2", text: "Shipped" },
];

function makeHarness(options?: {
  readonly projectMissing?: boolean;
  readonly instanceId?: ProviderInstanceId;
  readonly driverKind?: string;
  readonly items?: ReadonlyArray<unknown>;
  readonly snapshotWorkspaceRoot?: string;
  readonly startSessionNeverSettles?: boolean;
}) {
  const dispatched: OrchestrationCommand[] = [];
  const instanceId = options?.instanceId ?? codexInstanceId;
  const driverKind = ProviderDriverKind.make(options?.driverKind ?? "codex");
  const importSession = makeImportThread({
    crypto: testCrypto,
    orchestrationEngine: {
      dispatch: (command) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: dispatched.length });
      },
    },
    projectionSnapshotQuery: {
      getProjectShellById: () =>
        Effect.succeed(options?.projectMissing === true ? Option.none() : Option.some(project)),
      getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
    },
    providerService: {
      getInstanceInfo: () =>
        Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey: `${driverKind}:instance:${instanceId}`,
          },
        }),
      startSession: (threadId) =>
        options?.startSessionNeverSettles === true
          ? Effect.never
          : Effect.succeed({ ...codexSession, threadId }),
      readThread: (threadId) =>
        Effect.succeed({
          threadId,
          workspaceRoot: options?.snapshotWorkspaceRoot ?? workspaceRoot,
          lastActivityAtMs,
          turns: [{ id: TurnId.make("turn-1"), items: options?.items ?? [] }],
        }),
    },
  });
  return { dispatched, importSession };
}

const dispatchedTypes = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
  dispatched.map((command) => command.type);

describe("importThread", () => {
  it.effect("creates a thread, imports the transcript, then binds the resumed session", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ items: codexTranscript });

      const result = yield* harness.importSession.importThread({
        projectId,
        modelSelection: codexModelSelection,
        externalId: "codex-thread-1",
      });

      expect(dispatchedTypes(harness.dispatched)).toEqual([
        "thread.create",
        "thread.messages.import",
        "thread.session.set",
      ]);
      const created = harness.dispatched[0];
      expect(created?.type === "thread.create" && created.projectId).toBe(projectId);
      expect(created?.type === "thread.create" && created.threadId).toBe(result.threadId);
      const imported = harness.dispatched[1];
      expect(
        imported?.type === "thread.messages.import" &&
          imported.messages.map((message) => [message.role, message.text]),
      ).toEqual([
        ["user", "Ship it"],
        ["assistant", "Shipped"],
      ]);
    }),
  );

  it.effect("stamps imported messages with the provider's own activity time", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ items: codexTranscript });

      yield* harness.importSession.importThread({
        projectId,
        modelSelection: codexModelSelection,
        externalId: "codex-thread-1",
      });

      const imported = harness.dispatched[1];
      const expectedCreatedAt = DateTime.formatIso(DateTime.makeUnsafe(lastActivityAtMs));
      expect(
        imported?.type === "thread.messages.import" &&
          imported.messages.every((message) => message.createdAt === expectedCreatedAt),
      ).toBe(true);
    }),
  );

  it.effect("refuses a codex thread that ran in another workspace", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        items: codexTranscript,
        snapshotWorkspaceRoot: "/home/dev/other",
      });

      const failure = yield* Effect.flip(
        harness.importSession.importThread({
          projectId,
          modelSelection: codexModelSelection,
          externalId: "codex-thread-elsewhere",
        }),
      );

      expect(failure.message).toContain("ran in /home/dev/other");
      expect(dispatchedTypes(harness.dispatched)).toEqual(["thread.create", "thread.delete"]);
    }),
  );

  it.effect("deletes the thread it created when the session has nothing to import", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ items: [] });

      const failure = yield* Effect.flip(
        harness.importSession.importThread({
          projectId,
          modelSelection: codexModelSelection,
          externalId: "codex-thread-empty",
        }),
      );

      expect(failure.message).toContain("has no conversation to import");
      expect(dispatchedTypes(harness.dispatched)).toEqual(["thread.create", "thread.delete"]);
    }),
  );

  it.effect("deletes the thread it created when the import is interrupted", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ items: codexTranscript, startSessionNeverSettles: true });

      const fiber = yield* Effect.forkChild(
        harness.importSession.importThread({
          projectId,
          modelSelection: codexModelSelection,
          externalId: "codex-thread-interrupted",
        }),
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);

      expect(dispatchedTypes(harness.dispatched)).toEqual(["thread.create", "thread.delete"]);
    }),
  );

  it.effect("refuses to import into a project that no longer exists", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ projectMissing: true });

      const failure = yield* Effect.flip(
        harness.importSession.importThread({
          projectId,
          modelSelection: codexModelSelection,
          externalId: "codex-thread-1",
        }),
      );

      expect(failure.message).toContain("no longer exists");
      expect(harness.dispatched).toEqual([]);
    }),
  );

  it.effect("refuses drivers other than Claude Code and Codex", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ instanceId: cursorInstanceId, driverKind: "cursor" });

      const failure = yield* Effect.flip(
        harness.importSession.importThread({
          projectId,
          modelSelection: { instanceId: cursorInstanceId, model: "auto" },
          externalId: "cursor-thread-1",
        }),
      );

      expect(failure.message).toContain("only supported for Claude Code and Codex");
      expect(harness.dispatched).toEqual([]);
    }),
  );
});

describe("resolveImportSession", () => {
  it.effect("reports no workspace for providers that cannot be located on disk", () =>
    Effect.gen(function* () {
      const harness = makeHarness();

      const resolved = yield* harness.importSession.resolveImportSession({
        instanceId: codexInstanceId,
        externalId: "codex-thread-1",
      });

      expect(resolved).toEqual({
        externalId: "codex-thread-1",
        workspaceRoot: null,
        projectId: null,
        title: null,
      });
    }),
  );
});
