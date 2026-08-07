import {
  EventId,
  ORCHESTRATION_V2_HANDOFF_PAYLOAD_MAX_BYTES,
  ORCHESTRATION_V2_HANDOFF_PAYLOAD_WARN_BYTES,
  OrchestrationV2HandoffBundleV1,
  OrchestrationV2HandoffError,
  ProjectId,
  ThreadHandoffId,
  ThreadId,
  type EnvironmentId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2HandoffPart,
  type OrchestrationV2HandoffPartKind,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type VcsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type { PlatformError } from "effect/PlatformError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { EventStoreV2 } from "./EventStore.ts";
import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import {
  classifyIncomingTip,
  handoffPreTagName,
  handoffRefName,
  handoffStashLabel,
  ThreadHandoffGit,
  type HandoffTipClassification,
} from "./ThreadHandoffGit.ts";

const HANDOFF_EVENT_PREFIX = "handoff";

/** File a part is staged under. Derived from the kind so both sides agree without negotiating. */
export function partFileName(kind: OrchestrationV2HandoffPartKind): string {
  switch (kind) {
    case "git-bundle":
      return "objects.bundle";
    case "tracked-patch":
      return "tracked.patch";
    case "untracked-tar":
      return "untracked.tar.gz";
    case "attachments-tar":
      return "attachments.tar.gz";
  }
}

export function sha256(contents: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(contents).digest("hex");
}

/**
 * Total payload size against the two ceilings.
 *
 * Both are checked while preparing, before anything has been sent, so a
 * refusal costs nothing on either machine and the warning has somewhere useful
 * to appear.
 */
export type HandoffPayloadVerdict = "ok" | "warn" | "refuse";

export function classifyPayloadSize(totalBytes: number): HandoffPayloadVerdict {
  if (totalBytes > ORCHESTRATION_V2_HANDOFF_PAYLOAD_MAX_BYTES) return "refuse";
  if (totalBytes > ORCHESTRATION_V2_HANDOFF_PAYLOAD_WARN_BYTES) return "warn";
  return "ok";
}

/**
 * The conversation this hop carries.
 *
 * Every item goes, along with the run ordinals they cover, which is the same
 * pairing `ContextHandoffService` already uses to describe what a receiving
 * provider session has and has not seen.
 */
export function conversationPayload(projection: OrchestrationV2ThreadProjection): {
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly coveredRunOrdinals: ReadonlyArray<number>;
} {
  return {
    items: projection.turnItems,
    coveredRunOrdinals: projection.runs.map((_, index) => index + 1),
  };
}

/**
 * The window of a staged part a read should return.
 *
 * Clamping the offset rather than rejecting a stale one keeps a resumed
 * transfer from failing on a retry that asks for bytes past the end, and
 * `complete` is what tells the caller to stop asking rather than making it
 * compare offsets itself.
 */
export function handoffChunkWindow(input: {
  readonly totalBytes: number;
  readonly offset: number;
  readonly chunkBytes: number;
}): { readonly offset: number; readonly end: number; readonly complete: boolean } {
  const offset = Math.max(0, Math.min(input.offset, input.totalBytes));
  const end = Math.min(offset + input.chunkBytes, input.totalBytes);
  return { offset, end, complete: end >= input.totalBytes };
}

export interface ThreadHandoffPreparation {
  readonly bundle: OrchestrationV2HandoffBundleV1;
  readonly totalBytes: number;
  readonly verdict: HandoffPayloadVerdict;
  readonly dirtyFileCount: number;
  readonly untrackedFileCount: number;
}

export interface ThreadHandoffApplication {
  readonly threadId: ThreadId;
  readonly classification: HandoffTipClassification;
  readonly stashRef: string | null;
  readonly preTag: string | null;
}

export interface ThreadHandoffServiceShape {
  /**
   * Reads the thread and its worktree and stages the parts. Writes nothing the
   * user can see and does not lock the thread, so the preflight a user
   * approves comes from the same code path the transfer itself uses.
   */
  readonly prepare: (input: {
    readonly threadId: ThreadId;
    readonly peerEnvironmentId: EnvironmentId;
    /** The destination's current tip for this branch, so the bundle carries only what it lacks. */
    readonly peerBranchTip: string | null;
    readonly previousHandoffId: ThreadHandoffId | null;
    readonly hopCount: number;
  }) => Effect.Effect<ThreadHandoffPreparation, OrchestrationV2HandoffError>;
  /** Absolute path a part is staged at, for the transport to read from or write to. */
  readonly partPath: (input: {
    readonly handoffId: ThreadHandoffId;
    readonly kind: OrchestrationV2HandoffPartKind;
  }) => string;
  readonly verifyStagedPart: (input: {
    readonly handoffId: ThreadHandoffId;
    readonly part: OrchestrationV2HandoffPart;
  }) => Effect.Effect<void, OrchestrationV2HandoffError>;
  /**
   * Applies a staged bundle, creating the thread or — when the hop returns to
   * a thread this environment already owns — continuing it.
   */
  readonly receive: (input: {
    readonly bundle: OrchestrationV2HandoffBundleV1;
    readonly projectId: ProjectId;
    readonly returningThreadId: ThreadId | null;
  }) => Effect.Effect<ThreadHandoffApplication, OrchestrationV2HandoffError>;
  /**
   * Fails hops that were still applying when the server stopped. That is the
   * only state in which a repository can have been written to, so it is the
   * only state that needs recovering.
   */
  readonly recoverInterrupted: () => Effect.Effect<number>;
}

export class ThreadHandoffService extends Context.Service<
  ThreadHandoffService,
  ThreadHandoffServiceShape
>()("t3/orchestration-v2/ThreadHandoffService") {}

const handoffError = (input: {
  readonly reason: OrchestrationV2HandoffError["reason"];
  readonly message: string;
  readonly handoffId?: ThreadHandoffId;
  readonly cause?: unknown;
}) =>
  new OrchestrationV2HandoffError({
    reason: input.reason,
    message: input.message,
    ...(input.handoffId === undefined ? {} : { handoffId: input.handoffId }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });

const isHandoffError = Schema.is(OrchestrationV2HandoffError);

/**
 * Turns a dependency's failure into a handoff failure, leaving one that is
 * already a handoff failure alone so the specific reason a step chose is not
 * flattened into the generic one of its caller.
 */
const asHandoffError = (reason: OrchestrationV2HandoffError["reason"], message: string) =>
  Effect.mapError(
    (cause: unknown): OrchestrationV2HandoffError =>
      isHandoffError(cause) ? cause : handoffError({ reason, message, cause }),
  );

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const eventStore = yield* EventStoreV2;
  const projectionStore = yield* ProjectionStoreV2;
  const git = yield* ThreadHandoffGit;
  const projects = yield* ProjectService;
  const repositoryIdentity = yield* RepositoryIdentityResolver;
  const environment = yield* ServerEnvironment;
  const providerAdapters = yield* ProviderAdapterRegistryV2;
  const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2HandoffBundleV1));

  // One hop at a time per thread: prepare reads a working tree a receive may be
  // rewriting, and two concurrent hops would each believe they own the thread.
  const serialize = yield* makeKeyedSerialExecutor<string>();

  const handoffDir = (handoffId: ThreadHandoffId) => path.join(config.handoffsDir, handoffId);

  const partPath: ThreadHandoffServiceShape["partPath"] = (input) =>
    path.join(handoffDir(input.handoffId), partFileName(input.kind));

  const stagePart = (input: {
    readonly handoffId: ThreadHandoffId;
    readonly kind: OrchestrationV2HandoffPartKind;
    readonly write: (targetPath: string) => Effect.Effect<void, PlatformError | VcsError>;
  }) =>
    Effect.gen(function* () {
      const target = partPath({ handoffId: input.handoffId, kind: input.kind });
      yield* fs.makeDirectory(handoffDir(input.handoffId), { recursive: true });
      yield* input.write(target);
      const exists = yield* fs.exists(target);
      if (!exists) return null;
      const contents = yield* fs.readFile(target);
      // An empty part is the absence of a payload, not a payload of zero bytes:
      // dropping it keeps the manifest an accurate list of what has to move.
      if (contents.length === 0) {
        yield* fs.remove(target).pipe(Effect.ignore);
        return null;
      }
      return {
        kind: input.kind,
        digest: sha256(contents),
        byteLength: contents.length,
      } satisfies OrchestrationV2HandoffPart;
    }).pipe(asHandoffError("store_failed", `Could not stage the ${input.kind} part.`));

  const verifyStagedPart: ThreadHandoffServiceShape["verifyStagedPart"] = (input) =>
    Effect.gen(function* () {
      const target = partPath({ handoffId: input.handoffId, kind: input.part.kind });
      const exists = yield* fs
        .exists(target)
        .pipe(asHandoffError("store_failed", "Could not read a staged handoff part."));
      if (!exists) {
        return yield* handoffError({
          reason: "part_missing",
          message: `Handoff part ${input.part.kind} was never uploaded.`,
          handoffId: input.handoffId,
        });
      }
      const contents = yield* fs
        .readFile(target)
        .pipe(asHandoffError("store_failed", "Could not read a staged handoff part."));
      if (sha256(contents) !== input.part.digest) {
        return yield* handoffError({
          reason: "part_digest_mismatch",
          message: `Handoff part ${input.part.kind} does not match the digest in the manifest.`,
          handoffId: input.handoffId,
        });
      }
    });

  const recordHop = (input: {
    readonly handoffId: ThreadHandoffId;
    readonly threadId: ThreadId;
    readonly peerEnvironmentId: EnvironmentId;
    readonly peerThreadId: ThreadId | null;
    readonly previousHandoffId: ThreadHandoffId | null;
    readonly hopCount: number;
    readonly state: string;
    readonly bundle: OrchestrationV2HandoffBundleV1;
  }) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const manifestJson = yield* encodeManifest(input.bundle);
      yield* sql`
        INSERT INTO orchestration_v2_thread_handoffs (
          handoff_id,
          thread_id,
          peer_environment_id,
          peer_thread_id,
          previous_handoff_id,
          hop_count,
          state,
          manifest_json,
          created_at,
          updated_at
        ) VALUES (
          ${input.handoffId},
          ${input.threadId},
          ${input.peerEnvironmentId},
          ${input.peerThreadId},
          ${input.previousHandoffId},
          ${input.hopCount},
          ${input.state},
          ${manifestJson},
          ${now},
          ${now}
        )
        ON CONFLICT(handoff_id) DO UPDATE SET
          state = excluded.state,
          peer_thread_id = excluded.peer_thread_id,
          manifest_json = excluded.manifest_json,
          updated_at = excluded.updated_at
      `;
    }).pipe(asHandoffError("store_failed", "Could not record the handoff."));

  const markHop = (input: {
    readonly handoffId: ThreadHandoffId;
    readonly state: string;
    readonly lastError: string | null;
    readonly appliedHeadSha?: string | null;
    readonly stashRef?: string | null;
    readonly preTag?: string | null;
  }) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE orchestration_v2_thread_handoffs
        SET
          state = ${input.state},
          last_error = ${input.lastError},
          applied_head_sha = COALESCE(${input.appliedHeadSha ?? null}, applied_head_sha),
          stash_ref = COALESCE(${input.stashRef ?? null}, stash_ref),
          pre_tag = COALESCE(${input.preTag ?? null}, pre_tag),
          updated_at = ${now}
        WHERE handoff_id = ${input.handoffId}
      `;
    }).pipe(asHandoffError("store_failed", "Could not update the handoff."));

  const workspaceRootFor = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      asHandoffError("project_missing", `Project ${projectId} could not be read.`),
      Effect.flatMap((project) =>
        Option.isNone(project)
          ? handoffError({
              reason: "project_missing",
              message: `Project ${projectId} is not on this environment.`,
            })
          : Effect.succeed(project.value.workspaceRoot),
      ),
    );

  const repositoryIdentityFor = (cwd: string) =>
    repositoryIdentity.resolve(cwd).pipe(
      Effect.flatMap((identity) =>
        identity === null
          ? handoffError({
              reason: "repository_mismatch",
              message:
                "This thread's workspace has no git remote, so the other machine cannot recognise the repository.",
            })
          : Effect.succeed(identity),
      ),
    );

  const driverKindFor = (thread: OrchestrationV2AppThread) =>
    providerAdapters.get(thread.providerInstanceId).pipe(
      Effect.map((adapter) => adapter.driver),
      asHandoffError(
        "environment_unsupported",
        `Provider ${thread.providerInstanceId} is not configured here.`,
      ),
    );

  const threadCwd = (thread: OrchestrationV2AppThread) =>
    thread.worktreePath === null
      ? workspaceRootFor(thread.projectId)
      : Effect.succeed(thread.worktreePath);

  const prepare: ThreadHandoffServiceShape["prepare"] = (input) =>
    serialize.withLock(
      input.threadId,
      Effect.gen(function* () {
        const projection = yield* projectionStore
          .getThreadProjection(input.threadId)
          .pipe(asHandoffError("thread_missing", `Thread ${input.threadId} could not be read.`));
        const thread = projection.thread;
        if ((thread.handoff ?? null) !== null) {
          return yield* handoffError({
            reason: "thread_already_away",
            message: `Thread ${input.threadId} is already handed off.`,
          });
        }

        const cwd = yield* threadCwd(thread);
        const handoffId = ThreadHandoffId.make(NodeCrypto.randomUUID());
        const branch = thread.branch;
        const headSha = yield* git
          .resolveHead({ cwd })
          .pipe(asHandoffError("apply_failed", "Could not read the thread's HEAD."));
        // Checkpoint refs are hidden git refs, so bundling them alongside the
        // commits carries the whole checkpoint timeline with no payload of its
        // own, and revert keeps working on the far side.
        const checkpointRefs = yield* git
          .listCheckpointRefs({ cwd })
          .pipe(asHandoffError("apply_failed", "Could not list checkpoint refs."));
        const patch = yield* git
          .trackedPatch({ cwd })
          .pipe(asHandoffError("apply_failed", "Could not read the thread's tracked changes."));
        const untracked = yield* git
          .untrackedPaths({ cwd })
          .pipe(asHandoffError("apply_failed", "Could not list untracked files."));
        const dirtyFileCount = yield* git
          .dirtyFileCount({ cwd })
          .pipe(asHandoffError("apply_failed", "Could not count changed files."));

        const parts: Array<OrchestrationV2HandoffPart> = [];
        const bundlePart = yield* stagePart({
          handoffId,
          kind: "git-bundle",
          write: (target) =>
            git.createBundle({
              cwd,
              outputPath: target,
              refs: [...(branch === null ? ["HEAD"] : [`refs/heads/${branch}`]), ...checkpointRefs],
              // With no known peer tip, cut against this repository's
              // remote-tracking refs: both sides clone the same remote, so
              // anything a remote already has is not worth shipping. Without
              // this a first hop bundles the repository's entire history.
              excludeTips: input.peerBranchTip === null ? ["--remotes"] : [input.peerBranchTip],
            }),
        });
        if (bundlePart !== null) parts.push(bundlePart);

        const patchPart = yield* stagePart({
          handoffId,
          kind: "tracked-patch",
          write: (target) => fs.writeFileString(target, patch),
        });
        if (patchPart !== null) parts.push(patchPart);

        if (untracked.length > 0) {
          const untrackedPart = yield* stagePart({
            handoffId,
            kind: "untracked-tar",
            write: (target) => git.archivePaths({ cwd, paths: untracked, outputPath: target }),
          });
          if (untrackedPart !== null) parts.push(untrackedPart);
        }

        const totalBytes = parts.reduce((sum, part) => sum + part.byteLength, 0);
        const verdict = classifyPayloadSize(totalBytes);
        if (verdict === "refuse") {
          yield* fs.remove(handoffDir(handoffId), { recursive: true }).pipe(Effect.ignore);
          return yield* handoffError({
            reason: "payload_too_large",
            message: `This thread's working state is ${Math.round(
              totalBytes / (1024 * 1024),
            )} MB, over the ${Math.round(
              ORCHESTRATION_V2_HANDOFF_PAYLOAD_MAX_BYTES / (1024 * 1024),
            )} MB limit. Ignore or clean build output and try again.`,
            handoffId,
          });
        }

        const environmentId = yield* environment.getEnvironmentId;
        const descriptor = yield* environment.getDescriptor;
        const bundle: OrchestrationV2HandoffBundleV1 = {
          version: 1,
          handoffId,
          origin: {
            environmentId,
            threadId: thread.id,
            serverVersion: descriptor.serverVersion,
          },
          repository: yield* repositoryIdentityFor(cwd),
          workspace: {
            branch,
            headSha,
            strategy:
              thread.worktreePath === null
                ? { type: "root", ...(branch === null ? {} : { branch }) }
                : {
                    type: "existing_worktree",
                    worktreePath: thread.worktreePath,
                    ...(branch === null ? {} : { branch }),
                  },
          },
          conversation: conversationPayload(projection),
          provider: {
            driverKind: yield* driverKindFor(thread),
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
          },
          thread: { title: thread.title },
          terminals: [],
          lineage: {
            previousHandoffId: input.previousHandoffId,
            hopCount: input.hopCount,
          },
          parts,
        };

        yield* recordHop({
          handoffId,
          threadId: thread.id,
          peerEnvironmentId: input.peerEnvironmentId,
          peerThreadId: null,
          previousHandoffId: input.previousHandoffId,
          hopCount: input.hopCount,
          state: "preparing",
          bundle,
        });

        return {
          bundle,
          totalBytes,
          verdict,
          dirtyFileCount,
          untrackedFileCount: untracked.length,
        } satisfies ThreadHandoffPreparation;
      }),
    );

  const rollback = (input: {
    readonly cwd: string;
    readonly preTag: string | null;
    readonly stashRef: string | null;
  }) =>
    Effect.gen(function* () {
      if (input.preTag !== null) {
        yield* git.resetHardTo({ cwd: input.cwd, commit: input.preTag }).pipe(Effect.ignore);
      }
      if (input.stashRef !== null) {
        yield* git.popStash({ cwd: input.cwd, stashRef: input.stashRef }).pipe(Effect.ignore);
      }
    });

  /**
   * Replays the carried conversation as this environment's own history. A
   * returning hop continues the thread that is already here; a first arrival
   * creates one. Either way the handoff link is what marks this side live.
   */
  const writeArrival = (input: {
    readonly bundle: OrchestrationV2HandoffBundleV1;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly existing: OrchestrationV2AppThread | null;
  }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { bundle } = input;
      const base: OrchestrationV2AppThread = input.existing ?? {
        id: input.threadId,
        projectId: input.projectId,
        title: bundle.thread.title,
        providerInstanceId: bundle.provider.modelSelection.instanceId,
        modelSelection: bundle.provider.modelSelection,
        runtimeMode: bundle.provider.runtimeMode,
        interactionMode: bundle.provider.interactionMode,
        branch: bundle.workspace.branch,
        worktreePath:
          bundle.workspace.strategy.type === "existing_worktree"
            ? bundle.workspace.strategy.worktreePath
            : null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: input.threadId,
        },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "server",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const thread: OrchestrationV2AppThread = {
        ...base,
        handoff: {
          handoffId: bundle.handoffId,
          presence: "here",
          peerEnvironmentId: bundle.origin.environmentId,
          peerThreadId: bundle.origin.threadId,
          peerLabel: null,
          previousHandoffId: bundle.lineage.previousHandoffId,
          hopCount: bundle.lineage.hopCount,
          updatedAt: now,
        },
        updatedAt: now,
      };
      const returning = input.existing !== null;
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: EventId.make(`${HANDOFF_EVENT_PREFIX}:${bundle.handoffId}:thread`),
          type: returning ? "thread.handoff-returned" : "thread.created",
          threadId: thread.id,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: now,
          payload: thread,
        },
        ...(returning
          ? []
          : [
              {
                id: EventId.make(`${HANDOFF_EVENT_PREFIX}:${bundle.handoffId}:arrived`),
                type: "thread.handoff-arrived" as const,
                threadId: thread.id,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: now,
                payload: thread,
              },
            ]),
      ];
      yield* eventStore.append({ events });
      return thread;
    }).pipe(
      asHandoffError(
        "store_failed",
        "Could not write the arrival into this environment's history.",
      ),
    );

  const receive: ThreadHandoffServiceShape["receive"] = (input) =>
    serialize.withLock(
      input.bundle.handoffId,
      Effect.gen(function* () {
        const { bundle } = input;
        yield* Effect.forEach(bundle.parts, (part) =>
          verifyStagedPart({ handoffId: bundle.handoffId, part }),
        );

        const cwd = yield* workspaceRootFor(input.projectId);
        const branch = bundle.workspace.branch;
        const incomingTip = bundle.workspace.headSha;
        const bundlePart = bundle.parts.find((part) => part.kind === "git-bundle") ?? null;

        const existing =
          input.returningThreadId === null
            ? null
            : yield* projectionStore.getThreadProjection(input.returningThreadId).pipe(
                Effect.map((projection) => projection.thread),
                asHandoffError(
                  "thread_missing",
                  `Thread ${input.returningThreadId} could not be read.`,
                ),
              );

        let classification: HandoffTipClassification = "advance";
        let preTag: string | null = null;
        let stashRef: string | null = null;

        if (bundlePart !== null) {
          const bundlePath = partPath({ handoffId: bundle.handoffId, kind: "git-bundle" });
          yield* git
            .importBundle({ cwd, bundlePath })
            .pipe(asHandoffError("apply_failed", "Could not import the incoming git objects."));
        }
        const incomingCommitKnown = yield* git
          .hasCommit({ cwd, commit: incomingTip })
          .pipe(asHandoffError("apply_failed", "Could not inspect the incoming commit."));
        if (!incomingCommitKnown) {
          yield* markHop({
            handoffId: bundle.handoffId,
            state: "failed",
            lastError: "incoming commit missing after import",
          });
          return yield* handoffError({
            reason: "apply_failed",
            message:
              "The incoming commit is not available here even after importing the bundle. Fetch the repository on this machine and try again.",
            handoffId: bundle.handoffId,
          });
        }
        {
          const localTip =
            branch === null
              ? null
              : yield* git
                  .resolveTip({ cwd, branch })
                  .pipe(asHandoffError("apply_failed", "Could not read the local branch tip."));
          classification = classifyIncomingTip({
            localTip,
            incomingTip,
            incomingContainsLocal:
              localTip !== null &&
              (yield* git
                .isAncestor({ cwd, ancestor: localTip, descendant: incomingTip })
                .pipe(asHandoffError("apply_failed", "Could not compare the branch tips."))),
            localContainsIncoming:
              localTip !== null &&
              (yield* git
                .isAncestor({ cwd, ancestor: incomingTip, descendant: localTip })
                .pipe(asHandoffError("apply_failed", "Could not compare the branch tips."))),
            hasCommonAncestor:
              localTip !== null &&
              (yield* git
                .hasCommonAncestor({ cwd, left: localTip, right: incomingTip })
                .pipe(asHandoffError("apply_failed", "Could not compare the branch tips."))),
          });

          if (classification === "diverged" || classification === "unrelated") {
            // Park the sender's commits and stop. Nothing on either machine has
            // moved, and the user is left holding both histories.
            const parkedRef = handoffRefName(bundle.origin.environmentId, branch ?? "HEAD");
            yield* git
              .writeRef({ cwd, ref: parkedRef, commit: incomingTip })
              .pipe(asHandoffError("apply_failed", "Could not park the incoming commits."));
            yield* markHop({
              handoffId: bundle.handoffId,
              state: "failed",
              lastError: `branch ${classification}`,
            });
            return yield* handoffError({
              reason: "workspace_diverged",
              message: `The branch moved on both machines, so nothing here was changed. The incoming commits are at ${parkedRef}.`,
              handoffId: bundle.handoffId,
            });
          }

          yield* markHop({ handoffId: bundle.handoffId, state: "applying", lastError: null });

          if (localTip !== null) {
            preTag = handoffPreTagName(bundle.handoffId);
            yield* git
              .tagCommit({ cwd, tag: preTag, commit: localTip })
              .pipe(asHandoffError("apply_failed", "Could not tag the current tip."));
            stashRef = yield* git
              .stashWorktree({ cwd, label: handoffStashLabel(bundle.handoffId, localTip) })
              .pipe(asHandoffError("apply_failed", "Could not set the local changes aside."));
          }

          if (classification === "advance" && branch !== null) {
            yield* git
              .checkoutBranchAt({ cwd, branch, commit: incomingTip })
              .pipe(
                asHandoffError("apply_failed", "Could not move the branch to the incoming commit."),
              );
          }
        }

        const patchPart = bundle.parts.find((part) => part.kind === "tracked-patch") ?? null;
        if (patchPart !== null) {
          const patch = yield* fs
            .readFileString(partPath({ handoffId: bundle.handoffId, kind: "tracked-patch" }))
            .pipe(asHandoffError("store_failed", "Could not read the staged patch."));
          // Dry run first: a patch that will not apply must leave the working
          // tree exactly as it was, not half-written.
          const applies = yield* git
            .applyPatch({ cwd, patch, check: true })
            .pipe(asHandoffError("apply_failed", "Could not test the incoming changes."));
          if (!applies) {
            yield* rollback({ cwd, preTag, stashRef });
            yield* markHop({
              handoffId: bundle.handoffId,
              state: "failed",
              lastError: "patch did not apply",
            });
            return yield* handoffError({
              reason: "apply_failed",
              message:
                "The incoming changes could not be applied here, so this repository was put back exactly as it was.",
              handoffId: bundle.handoffId,
            });
          }
          yield* git
            .applyPatch({ cwd, patch, check: false })
            .pipe(asHandoffError("apply_failed", "Could not apply the incoming changes."));
        }

        if (bundle.parts.some((part) => part.kind === "untracked-tar")) {
          yield* git
            .extractArchive({
              cwd,
              archivePath: partPath({ handoffId: bundle.handoffId, kind: "untracked-tar" }),
            })
            .pipe(asHandoffError("apply_failed", "Could not restore the untracked files."));
        }

        const threadId =
          input.returningThreadId ?? ThreadId.make(`thread:${NodeCrypto.randomUUID()}`);
        yield* writeArrival({
          bundle,
          threadId,
          projectId: input.projectId,
          existing,
        });
        yield* recordHop({
          handoffId: bundle.handoffId,
          threadId,
          peerEnvironmentId: bundle.origin.environmentId,
          peerThreadId: bundle.origin.threadId,
          previousHandoffId: bundle.lineage.previousHandoffId,
          hopCount: bundle.lineage.hopCount,
          state: "arrived",
          bundle,
        });
        yield* markHop({
          handoffId: bundle.handoffId,
          state: "arrived",
          lastError: null,
          appliedHeadSha: incomingTip,
          stashRef,
          preTag,
        });

        return { threadId, classification, stashRef, preTag } satisfies ThreadHandoffApplication;
      }),
    );

  const recoverInterrupted: ThreadHandoffServiceShape["recoverInterrupted"] = () =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly handoff_id: string }>`
        SELECT handoff_id FROM orchestration_v2_thread_handoffs WHERE state = 'applying'
      `;
      yield* Effect.forEach(
        rows,
        (row) =>
          markHop({
            handoffId: ThreadHandoffId.make(row.handoff_id),
            state: "failed",
            lastError: "server stopped while applying",
          }).pipe(Effect.ignore),
        { discard: true },
      );
      return rows.length;
    }).pipe(Effect.orElseSucceed(() => 0));

  return {
    prepare,
    partPath,
    verifyStagedPart,
    receive,
    recoverInterrupted,
  } satisfies ThreadHandoffServiceShape;
});

export const layer: Layer.Layer<
  ThreadHandoffService,
  never,
  | SqlClient.SqlClient
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | EventStoreV2
  | ProjectionStoreV2
  | ThreadHandoffGit
  | ProjectService
  | RepositoryIdentityResolver
  | ServerEnvironment
  | ProviderAdapterRegistryV2
> = Layer.effect(ThreadHandoffService, make);
