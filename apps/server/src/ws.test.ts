import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  EventId,
  ProviderInstanceId,
  EnvironmentId,
  ProjectId,
  MessageId,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetFullThreadDiffError,
  type OrchestrationGetTurnDiffResult,
  type OrchestrationV2ThreadFamily,
  type OrchestrationV2WorktreeThreadIds,
  ThreadId,
  WS_METHODS,
  WsSubscribeServerConfigRpc,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2RpcSchemas,
  OrchestrationV2TemporaryThreadError,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationProjectShell,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { Headers } from "effect/http";
import { Rpc, RpcGroup, RpcMessage, RpcServer } from "effect/rpc";
import * as SqlClient from "effect/sql/SqlClient";

import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as AntigravityInstallation from "./provider/AntigravityInstallation.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import { CheckpointTurnRangeUnavailableError } from "./checkpointing/Errors.ts";
import * as CommandOutputHub from "./orchestration-v2/CommandOutputHub.ts";
import * as CodexInstallation from "./provider/CodexInstallation.ts";
import * as DeviceService from "./device/DeviceService.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as EventLoopMonitor from "./observability/EventLoopMonitor.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as OtlpEndpointCheck from "./observability/OtlpEndpointCheck.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as ProviderAuthService from "./provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import * as GuestShareService from "./guest/GuestShareService.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as TemporaryThreadService from "./orchestration-v2/TemporaryThreadService.ts";
import * as TemporaryThreadStorage from "./orchestration-v2/TemporaryThreadStorage.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfigModule from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as ServerSettings from "./serverSettings.ts";

import * as EventStore from "./orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "./orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import {
  layerWsRpc,
  persistChatAttachments,
  subscribeOrchestrationV2Shell,
  subscribeOrchestrationV2Thread,
  WS_RPC_SERVER_OPTIONS,
  withLateEditorConfig,
} from "./ws.ts";

const snapshotConfig = (fields: Partial<ServerConfig>) =>
  ({ availableEditors: [], settings: {}, ...fields }) as unknown as ServerConfig;

const isTurnDiffError = Schema.is(OrchestrationGetTurnDiffError);
const isFullThreadDiffError = Schema.is(OrchestrationGetFullThreadDiffError);
const isCheckpointTurnRangeUnavailableError = Schema.is(CheckpointTurnRangeUnavailableError);
const isThreadProjectionError = Schema.is(OrchestrationV2GetThreadProjectionError);

it.effect("rejects temporary image persistence before writing attachment bytes", () =>
  Effect.gen(function* () {
    const writes: Array<string> = [];
    const result = yield* Effect.result(
      persistChatAttachments({
        threadId: ThreadId.make("temporary-image"),
        messageId: MessageId.make("message"),
        attachments: [
          {
            type: "image",
            name: "private.png",
            mimeType: "image/png",
            sizeBytes: 1,
            dataUrl: "data:image/png;base64,AQ==",
          },
        ],
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            ServerConfigModule.layerTest(process.cwd(), {
              prefix: "temporary-attachment-test-",
            }).pipe(Layer.provide(NodeServices.layer)),
            Layer.mock(TemporaryThreadStorage.TemporaryThreadStorage)({
              isTemporary: () => Effect.succeed(true),
              isDiscarded: () => Effect.succeed(false),
            }),
            Layer.succeed(
              FileSystem.FileSystem,
              FileSystem.makeNoop({
                writeFile: (path) =>
                  Effect.sync(() => {
                    writes.push(String(path));
                  }),
              }),
            ),
          ),
        ),
      ),
    );
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") assert.include(result.failure.message, "Keep this thread");
    assert.deepEqual(writes, []);
  }),
);

const settingsUpdated = (settings: object): ServerConfigStreamEvent => ({
  version: 1,
  type: "settingsUpdated",
  payload: { settings: settings as ServerConfig["settings"] },
});

it.effect("resends late editors without rolling back updates already sent", () =>
  Effect.gen(function* () {
    const settingsSent = yield* Deferred.make<void>();
    const events = yield* withLateEditorConfig(
      snapshotConfig({ settings: { enableProviderUpdateChecks: true } as never }),
      Stream.make(settingsUpdated({ enableProviderUpdateChecks: false })),
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () =>
          Deferred.await(settingsSent).pipe(Effect.as("file-explorer" as const)),
      },
    ).pipe(
      Stream.tap((event) =>
        event.type === "settingsUpdated" ? Deferred.succeed(settingsSent, undefined) : Effect.void,
      ),
      Stream.runCollect,
    );

    const [first, second] = Array.from(events);
    assert.equal(events.length, 2);
    assert.equal(first?.type, "settingsUpdated");
    assert.equal(second?.type, "snapshot");
    if (second?.type === "snapshot") {
      assert.deepEqual(second.config.availableEditors, ["file-manager"]);
      assert.equal(second.config.shellRevealInFileManagerKind, "file-explorer");
      assert.deepEqual(second.config.settings, { enableProviderUpdateChecks: false } as never);
    }
  }),
);

it.effect("resends a file manager reveal kind that missed the snapshot", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () => Effect.succeed("file-explorer"),
      },
    ).pipe(Stream.runCollect);

    const [late] = Array.from(events);
    assert.equal(events.length, 1);
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }),
);

it.effect.each([false, true])(
  "marks only authoritative missing thread snapshot failures, bounded=%s",
  (acceptBoundedSnapshot) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:cold-missing");
      for (const missing of [true, false]) {
        const cause = new Orchestrator.OrchestratorProjectionError({
          threadId,
          cause: missing
            ? new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId })
            : new ProjectionStore.ProjectionStoreReadError({ threadId }),
        });
        const result = yield* subscribeOrchestrationV2Thread({
          threadId,
          acceptTemporaryThreads: true,
          acceptBoundedSnapshot,
        }).pipe(
          Effect.flatMap(Stream.runCollect),
          Effect.result,
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(ThreadManagement.ThreadManagementService)({
                ensureLegacyTranscript: () => Effect.void,
                getThreadSnapshot: () => Effect.fail(cause),
                getThreadSnapshotWindow: () => Effect.fail(cause),
              }),
              Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
            ),
          ),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, OrchestrationV2GetThreadProjectionError);
          assert.deepInclude(result.failure, missing ? { reason: "thread_not_found" } : { cause });
          if (!missing) assert.notProperty(result.failure, "reason");
        }
      }
    }),
);

const ReplayTestLayer = OrchestrationEventStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.live.each(["thread", "shell"] as const)(
  "%s resume skips unknown types, synchronizes, and receives the live tail",
  (scope) =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-05T00:00:00.000Z";
      const threadId = ThreadId.make("thread:replay");
      const projectId = ProjectId.make("project:replay");
      const project = {
        id: projectId,
        title: "Replay",
        workspaceRoot: "/tmp/replay",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      } satisfies OrchestrationProjectShell;
      const insert = (version: number, unknown = false) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`replay:${version}`}, ${scope === "thread" ? "thread" : "project"},
          ${scope === "thread" ? threadId : projectId}, ${version},
          ${unknown ? "future.event" : scope === "thread" ? "provider-session.detached" : "project.meta-updated"},
          ${now}, 'server', ${JSON.stringify(
            scope === "thread"
              ? { providerSessionId: "session:replay", detachedAt: now }
              : { projectId, updatedAt: now },
          )}, '{}', 2
        ) RETURNING sequence
      `;
      const [before] = yield* insert(0);
      yield* insert(1, true);
      const [after] = yield* insert(2);
      const [highWater] = yield* insert(3, true);
      const updates = yield* PubSub.unbounded();
      let liveSequence = 0;
      const consume = <A extends { readonly kind: string; readonly sequence?: number }, E, R>(
        stream: Stream.Stream<A, E, R>,
      ) =>
        stream.pipe(
          Stream.tap((item) =>
            Effect.gen(function* () {
              if (item.kind !== "synchronized") return;
              const [live] = yield* insert(4);
              liveSequence = live!.sequence;
              const events = yield* store
                .readApplicationEvents({
                  afterSequence: highWater!.sequence,
                  throughSequence: liveSequence,
                })
                .pipe(Stream.runCollect);
              yield* store.publishCommitted(events);
            }),
          ),
          Stream.takeUntil((item) => item.sequence === liveSequence),
          Stream.map((item) => ({ kind: item.kind as string, sequence: item.sequence })),
          Stream.runCollect,
        );
      const subscription = Effect.gen(function* () {
        return scope === "thread"
          ? yield* subscribeOrchestrationV2Thread({
              threadId,
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume))
          : yield* subscribeOrchestrationV2Shell({
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume));
      });
      const items = yield* subscription.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          getShellSnapshot: () => Effect.die("shell resume must not load a full snapshot"),
          listActiveSubagentThreadIds: () => Effect.succeed([]),
          streamStoredEventsFrom: (
            input: Parameters<
              ThreadManagement.ThreadManagementService["Service"]["streamStoredEventsFrom"]
            >[0],
          ) => {
            assert.equal(input?.afterSequence, highWater!.sequence);
            return store
              .streamApplicationEvents({ afterSequence: input?.afterSequence ?? 0 })
              .pipe(
                Stream.filter((event): event is OrchestrationV2StoredEvent => "event" in event),
              );
          },
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedSome(project),
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(updates),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
      );
      assert.deepEqual(
        items.map((item) => item.kind),
        scope === "thread"
          ? ["event", "synchronized", "event"]
          : ["project.updated", "synchronized", "project.updated"],
      );
      assert.deepEqual(
        items.flatMap((item) => (item.sequence === undefined ? [] : [item.sequence])),
        [after!.sequence, liveSequence],
      );
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("shell snapshots leave idle subagent children out only for clients that ask", () =>
  Effect.gen(function* () {
    const shell = (id: string, parent: string | null, activityRunStatus: "running" | null) =>
      ({
        id: ThreadId.make(id),
        archivedAt: null,
        status: activityRunStatus ?? "completed",
        activityRunStatus,
        pendingRuntimeRequest: null,
        pendingBackgroundTasks: [],
        lineage: {
          parentThreadId: parent === null ? null : ThreadId.make(parent),
          relationshipToParent: parent === null ? null : "subagent",
          rootThreadId: ThreadId.make("parent"),
        },
      }) as unknown as OrchestrationV2ThreadShell;
    const threads = [
      shell("parent", null, null),
      shell("idle", "parent", null),
      shell("live", "parent", "running"),
    ];
    const firstSnapshotThreadIds = (input: { readonly omitIdleSubagents?: boolean }) =>
      subscribeOrchestrationV2Shell(input).pipe(
        Effect.flatMap((stream) => stream.pipe(Stream.take(1), Stream.runCollect)),
        Effect.map(([item]) =>
          item?.kind === "snapshot" ? item.snapshot.threads.map((thread) => thread.id) : [],
        ),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          readShellSnapshot: () =>
            Effect.succeed(
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads,
                archivedThreads: [],
              }),
            ),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedNone,
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideServiceEffect(
          ProjectEnrichment.ProjectEnrichmentService,
          PubSub.unbounded().pipe(
            Effect.map(
              (changes) =>
                ({
                  subscribeChanges: PubSub.subscribe(changes),
                }) as unknown as ProjectEnrichment.ProjectEnrichmentService["Service"],
            ),
          ),
        ),
      );

    assert.deepEqual(yield* firstSnapshotThreadIds({}), ["parent", "idle", "live"]);
    assert.deepEqual(yield* firstSnapshotThreadIds({ omitIdleSubagents: true }), [
      "parent",
      "live",
    ]);
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

// Build the production RPC layer; unrelated capabilities fail if this test calls them.
const layerUnusedConfigRpcServices = Layer.mergeAll(
  TemporaryThreadStorage.layer,
  Layer.mock(TemporaryThreadService.TemporaryThreadService)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
  Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({}),
  Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
  Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
  Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
  Layer.mock(AnalyticsService.AnalyticsService)({}),
  Layer.mock(AntigravityInstallation.AntigravityInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
  Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
  Layer.mock(CommandOutputHub.CommandOutputHub)({}),
  Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(HostResources.HostResources)({}),
  Layer.mock(McpAppRequests.McpAppRequests)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(OtlpEndpointCheck.OtlpEndpointCheck)({}),
  Layer.mock(PairingGrantStore.PairingGrantStore)({}),
  Layer.mock(PortScanner.PortDiscovery)({}),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
  Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
  Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(RelayClient.RelayClient)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(GuestShareService.GuestShareService)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(SessionStore.SessionStore)({ cookieName: "config-test", legacyCookieName: undefined }),
  Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(StorageCleanup.StorageCleanup)({}),
  Layer.mock(DatabaseStorage.DatabaseStorage)({}),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(UsageService.UsageService)({}),
  Layer.mock(VcsProvisioningService.VcsProvisioningService)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
  Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
  Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
);

const layerConfigSources = Layer.mergeAll(
  Keybindings.layer,
  ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer)),
).pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(
      ServerConfigModule.layerTest(process.cwd(), { prefix: "t3-config-subscription-test-" }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect.each(["family", "worktree"] as const)(
  "%s shell reads admit current temporary rows only with explicit opt-in",
  (kind) =>
    Effect.gen(function* () {
      const services = yield* Layer.build(
        Layer.mergeAll(
          layerUnusedConfigRpcServices,
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ).pipe(Layer.provideMerge(layerConfigSources)),
      );
      const storage = Context.get(services, TemporaryThreadStorage.TemporaryThreadStorage);
      const stores = Context.get(services, TemporaryThreadStorage.TemporaryThreadStores);
      const projection = Context.get(services, ProjectionStore.ProjectionStoreV2);
      const now = yield* DateTime.now;
      const create = (id: string, parent: string | null) => ({
        id: EventId.make(`create:${id}`),
        type: "thread.created" as const,
        threadId: ThreadId.make(id),
        occurredAt: now,
        payload: {
          id: ThreadId.make(id),
          createdBy: "user" as const,
          creationSource: "web" as const,
          projectId: ProjectId.make("absent-project"),
          title: id,
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: null,
          worktreePath: "/shared-worktree",
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: parent === null ? null : ThreadId.make(parent),
            relationshipToParent: parent === null ? null : ("subagent" as const),
            rootThreadId: ThreadId.make(parent ?? id),
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      for (const id of ["saved", "saved-child", "private", "private-child"]) {
        const parent = id.endsWith("-child") ? id.slice(0, -6) : null;
        if (id.startsWith("private"))
          yield* storage.register({
            threadId: ThreadId.make(id),
            ...(parent === null ? {} : { parentThreadId: ThreadId.make(parent) }),
          });
        yield* projection.apply(create(id, parent));
      }
      let keepDuringRead = false;
      const responses =
        yield* Queue.unbounded<
          Exit.Exit<
            OrchestrationV2ThreadFamily | OrchestrationV2WorktreeThreadIds,
            OrchestrationV2GetShellSnapshotError
          >
        >();
      const server = yield* RpcServer.makeNoSerialization(
        RpcGroup.make(
          Rpc.make(ORCHESTRATION_V2_WS_METHODS.getThreadFamily, {
            payload: OrchestrationV2RpcSchemas.getThreadFamily.input,
            success: OrchestrationV2RpcSchemas.getThreadFamily.output,
            error: OrchestrationV2GetShellSnapshotError,
          }),
          Rpc.make(ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds, {
            payload: OrchestrationV2RpcSchemas.getWorktreeThreadIds.input,
            success: OrchestrationV2RpcSchemas.getWorktreeThreadIds.output,
            error: OrchestrationV2GetShellSnapshotError,
          }),
        ),
        {
          ...WS_RPC_SERVER_OPTIONS,
          onFromServer: (response) =>
            response._tag === "Exit"
              ? Queue.offer(responses, response.exit).pipe(Effect.asVoid)
              : Effect.void,
        },
      ).pipe(
        Effect.provide(
          layerWsRpc(
            {
              sessionId: AuthSessionId.make("shell-row-privacy"),
              subject: "shell-row-privacy",
              method: "browser-session-cookie",
              scopes: [],
            },
            {},
            {},
            Context.get(services, PreviewAutomationBroker.PreviewAutomationBroker),
            Context.get(services, ServerBrowser.ServerBrowser),
            yield* Effect.scope,
          ).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(BackgroundPolicy.BackgroundPolicy)({
                  removeRpcClient: () => Effect.void,
                }),
                Layer.mock(EventLoopMonitor.EventLoopMonitor)({}),
                Layer.mock(ExternalLauncher.ExternalLauncher)({}),
                Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
                Layer.mock(DirectEndpoints.DirectEndpoints)({}),
                Layer.mock(ProviderRegistry.ProviderRegistry)({}),
                Layer.mock(UsageLimitSources.UsageLimitSources)({}),
                Layer.mock(ServerEnvironment.ServerEnvironment)({}),
                Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: process.cwd(),
                }),
                Layer.mock(ThreadManagement.ThreadManagementService)({
                  readShellSnapshot: (options) =>
                    projection.readShellSnapshot(options).pipe(
                      Effect.map((decode) =>
                        decode.pipe(
                          Effect.tap(() => {
                            if (!keepDuringRead) return Effect.void;
                            keepDuringRead = false;
                            return storage.keep({
                              threadId: ThreadId.make("racing"),
                              commandId: CommandId.make("keep-racing"),
                            });
                          }),
                          Effect.mapError(
                            (cause) =>
                              new Orchestrator.OrchestratorProjectionError({
                                threadId: ThreadId.make("thread:shell"),
                                cause,
                              }),
                          ),
                        ),
                      ),
                      Effect.mapError(
                        (cause) =>
                          new Orchestrator.OrchestratorProjectionError({
                            threadId: ThreadId.make("thread:shell"),
                            cause,
                          }),
                      ),
                    ),
                }),
              ),
            ),
            Layer.provide(Layer.succeedContext(services)),
          ),
        ),
      );
      let request = 0;
      const read = (acceptTemporaryThreads?: boolean, root = "private") =>
        Effect.gen(function* () {
          yield* server.write(0, {
            _tag: "Request",
            id: RpcMessage.RequestId(`shell:${request++}`),
            tag:
              kind === "family"
                ? ORCHESTRATION_V2_WS_METHODS.getThreadFamily
                : ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds,
            payload: {
              ...(kind === "family"
                ? { threadId: ThreadId.make(root) }
                : { worktreePath: "/shared-worktree" }),
              ...(acceptTemporaryThreads === undefined ? {} : { acceptTemporaryThreads }),
            },
            headers: Headers.empty,
          });
          const result = yield* Queue.take(responses);
          const value = yield* result;
          return (
            "threadIds" in value ? value.threadIds : value.threads.map((row) => row.id)
          ).toSorted();
        });
      const saved = kind === "family" ? [] : ["saved", "saved-child"];
      for (const optIn of [undefined, false]) assert.deepEqual(yield* read(optIn), saved);
      assert.deepEqual(
        yield* read(false, "saved"),
        kind === "family" ? ["saved-child"] : ["saved", "saved-child"],
      );
      const admitted =
        kind === "family"
          ? ["private-child"]
          : ["private", "private-child", "saved", "saved-child"];
      assert.deepEqual(yield* read(true), admitted);
      yield* storage.keep({
        threadId: ThreadId.make("private"),
        commandId: CommandId.make("keep"),
      });
      yield* stores.volatile.projectionStore.apply(create("private-child", "private"));
      for (const optIn of [undefined, false, true]) assert.deepEqual(yield* read(optIn), admitted);
      yield* storage.register({ threadId: ThreadId.make("discarded") });
      yield* storage.register({
        threadId: ThreadId.make("discarded-child"),
        parentThreadId: ThreadId.make("discarded"),
      });
      yield* projection.apply(create("discarded", null));
      yield* projection.apply(create("discarded-child", "discarded"));
      yield* storage.discard(ThreadId.make("discarded"));
      yield* stores.volatile.projectionStore.apply(create("discarded", null));
      yield* stores.volatile.projectionStore.apply(create("discarded-child", "discarded"));
      for (const optIn of [undefined, false, true])
        assert.deepEqual(yield* read(optIn, "discarded"), kind === "family" ? [] : admitted);
      yield* storage.register({ threadId: ThreadId.make("racing") });
      yield* storage.register({
        threadId: ThreadId.make("racing-child"),
        parentThreadId: ThreadId.make("racing"),
      });
      yield* projection.apply(create("racing", null));
      yield* projection.apply(create("racing-child", "racing"));
      keepDuringRead = true;
      assert.deepEqual(yield* read(true, "racing"), kind === "family" ? [] : admitted);
      assert.deepEqual(
        yield* read(false, "racing"),
        kind === "family"
          ? ["racing-child"]
          : ["private", "private-child", "racing", "racing-child", "saved", "saved-child"],
      );
    }).pipe(Effect.scoped),
);

it.effect.each(
  (["getTurnDiff", "getFullThreadDiff"] as const).flatMap((method) =>
    [0, 1].map((toTurnCount) => ({ method, toTurnCount })),
  ),
)(
  "$method gates temporary reads before checkpoint queries for turn count $toTurnCount",
  ({ method, toTurnCount }) =>
    Effect.gen(function* () {
      const services = yield* Layer.build(
        Layer.mergeAll(
          layerUnusedConfigRpcServices,
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ).pipe(Layer.provideMerge(layerConfigSources)),
      );
      const storage = Context.get(services, TemporaryThreadStorage.TemporaryThreadStorage);
      const projection = Context.get(services, ProjectionStore.ProjectionStoreV2);
      const now = yield* DateTime.now;
      const savedId = ThreadId.make("saved-diff");
      const temporaryId = ThreadId.make("temporary-diff");
      yield* storage.register({ threadId: temporaryId });
      for (const threadId of [savedId, temporaryId]) {
        yield* projection.apply({
          id: EventId.make(`create:${threadId}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            id: threadId,
            createdBy: "user",
            creationSource: "web",
            projectId: ProjectId.make("absent-project"),
            title: threadId,
            providerInstanceId: ProviderInstanceId.make("codex"),
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
      }
      let reads = 0;
      const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
        getCheckpointContext: (threadId) =>
          Effect.sync(() => reads++).pipe(
            Effect.andThen(projection.getCheckpointContext(threadId)),
            Effect.mapError(
              (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
            ),
          ),
      });
      const query = yield* Layer.build(
        CheckpointDiffQuery.layer.pipe(
          Layer.provide(threads),
          Layer.provide(Layer.mock(CheckpointStore.CheckpointStore)({})),
          Layer.provide(NodeCrypto.layer),
        ),
      );
      const responses =
        yield* Queue.unbounded<
          Exit.Exit<
            OrchestrationGetTurnDiffResult,
            OrchestrationGetTurnDiffError | OrchestrationGetFullThreadDiffError
          >
        >();
      const server = yield* RpcServer.makeNoSerialization(
        RpcGroup.make(
          Rpc.make(ORCHESTRATION_V2_WS_METHODS.getTurnDiff, {
            payload: OrchestrationV2RpcSchemas.getTurnDiff.input,
            success: OrchestrationV2RpcSchemas.getTurnDiff.output,
            error: OrchestrationGetTurnDiffError,
          }),
          Rpc.make(ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff, {
            payload: OrchestrationV2RpcSchemas.getFullThreadDiff.input,
            success: OrchestrationV2RpcSchemas.getFullThreadDiff.output,
            error: OrchestrationGetFullThreadDiffError,
          }),
        ),
        {
          ...WS_RPC_SERVER_OPTIONS,
          onFromServer: (response) =>
            response._tag === "Exit"
              ? Queue.offer(responses, response.exit).pipe(Effect.asVoid)
              : Effect.void,
        },
      ).pipe(
        Effect.provide(
          layerWsRpc(
            {
              sessionId: AuthSessionId.make("diff-privacy"),
              subject: "diff-privacy",
              method: "browser-session-cookie",
              scopes: [],
            },
            {},
            {},
            Context.get(services, PreviewAutomationBroker.PreviewAutomationBroker),
            Context.get(services, ServerBrowser.ServerBrowser),
            yield* Effect.scope,
          ).pipe(
            Layer.provide(
              Layer.mergeAll(
                threads,
                Layer.mock(BackgroundPolicy.BackgroundPolicy)({
                  removeRpcClient: () => Effect.void,
                }),
                Layer.mock(EventLoopMonitor.EventLoopMonitor)({}),
                Layer.mock(ExternalLauncher.ExternalLauncher)({}),
                Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
                Layer.mock(DirectEndpoints.DirectEndpoints)({}),
                Layer.mock(ProviderRegistry.ProviderRegistry)({}),
                Layer.mock(UsageLimitSources.UsageLimitSources)({}),
                Layer.mock(ServerEnvironment.ServerEnvironment)({}),
                Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: process.cwd(),
                }),
              ),
            ),
            Layer.provide(Layer.succeedContext(Context.merge(services, query))),
          ),
        ),
      );
      let request = 0;
      const check = (
        threadId: ThreadId,
        acceptTemporaryThreads: boolean | undefined,
        allowed: boolean,
      ) =>
        Effect.gen(function* () {
          const before = reads;
          yield* server.write(0, {
            _tag: "Request",
            id: RpcMessage.RequestId(`diff:${request++}`),
            tag: ORCHESTRATION_V2_WS_METHODS[method],
            payload: {
              threadId,
              ...(method === "getTurnDiff" ? { fromTurnCount: 0 } : {}),
              toTurnCount,
              ...(acceptTemporaryThreads === undefined ? {} : { acceptTemporaryThreads }),
            },
            headers: Headers.empty,
          });
          const result = yield* Queue.take(responses);
          if (allowed && toTurnCount === 0) {
            assert.deepEqual(yield* result, {
              threadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            });
          } else {
            assert.isTrue(Exit.isFailure(result));
            if (Exit.isFailure(result)) {
              const reason = result.cause.reasons[0];
              assert.equal(reason?._tag, "Fail");
              if (reason?._tag === "Fail") {
                if (method === "getTurnDiff") assert.isTrue(isTurnDiffError(reason.error));
                else assert.isTrue(isFullThreadDiffError(reason.error));
                if (allowed)
                  assert.isTrue(isCheckpointTurnRangeUnavailableError(reason.error.cause));
                else assert.isTrue(isThreadProjectionError(reason.error.cause));
              }
            }
          }
          assert.equal(reads - before, allowed && toTurnCount === 1 ? 1 : 0);
        });
      for (const optIn of [undefined, false, true]) yield* check(savedId, optIn, true);
      yield* check(temporaryId, true, true);
      for (const optIn of [undefined, false]) yield* check(temporaryId, optIn, false);
      yield* storage.discard(temporaryId);
      for (const optIn of [undefined, false, true]) yield* check(temporaryId, optIn, false);
    }).pipe(Effect.scoped),
);

it.effect.each(
  [
    { discarded: true, acceptTemporaryThreads: true },
    { discarded: true, acceptTemporaryThreads: false },
    { discarded: false, acceptTemporaryThreads: false },
    { discarded: false, acceptTemporaryThreads: true },
  ].flatMap((state) =>
    [
      { tag: ORCHESTRATION_V2_WS_METHODS.getThreadProjection },
      { tag: ORCHESTRATION_V2_WS_METHODS.subscribeThread, acceptBoundedSnapshot: false },
      { tag: ORCHESTRATION_V2_WS_METHODS.subscribeThread, acceptBoundedSnapshot: true },
    ].map((request) => ({ ...state, ...request })),
  ),
)("marks only discarded temporary thread RPC reads as missing: %s", (state) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      Layer.mergeAll(
        layerUnusedConfigRpcServices,
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ).pipe(Layer.provideMerge(layerConfigSources)),
    );
    const storage = Context.get(services, TemporaryThreadStorage.TemporaryThreadStorage);
    const threadId = ThreadId.make("temporary-rpc-read");
    yield* storage.register({ threadId });
    if (state.discarded) yield* storage.discard(threadId);
    const cause = new Orchestrator.OrchestratorProjectionError({ threadId });
    let reads = 0;
    const read = () => Effect.sync(() => reads++).pipe(Effect.andThen(Effect.fail(cause)));
    const responses = yield* Queue.unbounded<Exit.Exit<unknown, unknown>>();
    const server = yield* RpcServer.makeNoSerialization(
      RpcGroup.make(
        Rpc.make(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
          payload: OrchestrationV2RpcSchemas.getThreadProjection.input,
          error: OrchestrationV2GetThreadProjectionError,
        }),
        Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeThread, {
          payload: OrchestrationV2RpcSchemas.subscribeThread.input,
          error: OrchestrationV2GetThreadProjectionError,
          stream: true,
        }),
      ),
      {
        ...WS_RPC_SERVER_OPTIONS,
        onFromServer: (response) =>
          response._tag === "Exit"
            ? Queue.offer(responses, response.exit).pipe(Effect.asVoid)
            : Effect.void,
      },
    ).pipe(
      Effect.provide(
        layerWsRpc(
          {
            sessionId: AuthSessionId.make("temporary-rpc-read"),
            subject: "temporary-rpc-read",
            method: "browser-session-cookie",
            scopes: [],
          },
          {},
          {},
          Context.get(services, PreviewAutomationBroker.PreviewAutomationBroker),
          Context.get(services, ServerBrowser.ServerBrowser),
          yield* Effect.scope,
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(BackgroundPolicy.BackgroundPolicy)({ removeRpcClient: () => Effect.void }),
              Layer.mock(EventLoopMonitor.EventLoopMonitor)({}),
              Layer.mock(ExternalLauncher.ExternalLauncher)({}),
              Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
              Layer.mock(DirectEndpoints.DirectEndpoints)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
              Layer.mock(UsageLimitSources.UsageLimitSources)({}),
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: process.cwd(),
              }),
              Layer.mock(ServerEnvironment.ServerEnvironment)({}),
              Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
              Layer.mock(ThreadManagement.ThreadManagementService)({
                ensureLegacyTranscript: () => Effect.void,
                getThreadSnapshot: read,
                getThreadSnapshotWindow: read,
              }),
            ),
          ),
          Layer.provide(Layer.succeedContext(services)),
        ),
      ),
    );
    yield* server.write(0, {
      _tag: "Request",
      id: RpcMessage.RequestId("read"),
      tag: state.tag,
      payload: { threadId, ...state },
      headers: Headers.empty,
    });
    const result = yield* Queue.take(responses);
    assert.isTrue(Exit.isFailure(result));
    if (Exit.isFailure(result)) {
      const error = result.cause.reasons[0];
      assert.equal(error?._tag, "Fail");
      if (error?._tag === "Fail") {
        assert.instanceOf(error.error, OrchestrationV2GetThreadProjectionError);
        if (state.discarded) assert.deepInclude(error.error, { reason: "thread_not_found" });
        else assert.notProperty(error.error, "reason");
        if (state.acceptTemporaryThreads && !state.discarded)
          assert.deepInclude(error.error, { cause });
      }
    }
    assert.equal(reads, state.acceptTemporaryThreads && !state.discarded ? 1 : 0);
  }).pipe(Effect.scoped),
);

it.effect.each([false, true])(
  "expires a reloaded socket view after handler setup returns with another tab=%s",
  (anotherTab) =>
    Effect.gen(function* () {
      const services = yield* Layer.build(
        Layer.mergeAll(
          layerUnusedConfigRpcServices,
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ).pipe(Layer.provideMerge(layerConfigSources)),
      );
      const storage = Context.get(services, TemporaryThreadStorage.TemporaryThreadStorage);
      const lifecycle = yield* Layer.build(
        TemporaryThreadService.layer.pipe(
          Layer.provide(TemporaryThreadService.layerState),
          Layer.provide(
            Layer.succeed(TemporaryThreadService.TemporaryThreadCleanup, {
              stopAndTeardown: () => Effect.void,
            }),
          ),
          Layer.provide(Layer.succeedContext(services)),
        ),
      );
      const temporaryThreads = Context.get(
        lifecycle,
        TemporaryThreadService.TemporaryThreadService,
      );
      const threadId = ThreadId.make("reloaded-socket");
      const responses = yield* Queue.unbounded<Exit.Exit<unknown, unknown>>();
      const socketScope = yield* Scope.fork(yield* Effect.scope);
      const server = yield* RpcServer.makeNoSerialization(
        RpcGroup.make(
          Rpc.make(ORCHESTRATION_V2_WS_METHODS.updateTemporaryThreadViews, {
            payload: OrchestrationV2RpcSchemas.updateTemporaryThreadViews.input,
            error: OrchestrationV2TemporaryThreadError,
          }),
        ),
        {
          ...WS_RPC_SERVER_OPTIONS,
          onFromServer: (response) =>
            response._tag === "Exit"
              ? Queue.offer(responses, response.exit).pipe(Effect.asVoid)
              : Effect.void,
        },
      ).pipe(
        Effect.provide(
          layerWsRpc(
            {
              sessionId: AuthSessionId.make("reload-session"),
              subject: "reload-session",
              method: "browser-session-cookie",
              scopes: [],
            },
            {},
            {},
            Context.get(services, PreviewAutomationBroker.PreviewAutomationBroker),
            Context.get(services, ServerBrowser.ServerBrowser),
            socketScope,
          ).pipe(
            Layer.provide(Layer.succeedContext(lifecycle)),
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(BackgroundPolicy.BackgroundPolicy)({
                  removeRpcClient: () => Effect.void,
                }),
                Layer.mock(EventLoopMonitor.EventLoopMonitor)({}),
                Layer.mock(ExternalLauncher.ExternalLauncher)({}),
                Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
                Layer.mock(DirectEndpoints.DirectEndpoints)({}),
                Layer.mock(ProviderRegistry.ProviderRegistry)({}),
                Layer.mock(UsageLimitSources.UsageLimitSources)({}),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: process.cwd(),
                }),
                Layer.mock(ServerEnvironment.ServerEnvironment)({}),
                Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
              ),
            ),
            Layer.provide(Layer.succeedContext(services)),
          ),
        ),
        Scope.provide(socketScope),
      );
      yield* server.write(0, {
        _tag: "Request",
        id: RpcMessage.RequestId("attach"),
        tag: ORCHESTRATION_V2_WS_METHODS.updateTemporaryThreadViews,
        payload: {
          viewId: "old-document",
          generation: 1,
          threadIds: [threadId],
          background: false,
        },
        headers: Headers.empty,
      });
      assert.isTrue(Exit.isSuccess(yield* Queue.take(responses)));
      assert.isTrue(yield* storage.isTemporary(threadId));
      const reloadIdentity = { sessionId: "reload-session", clientId: "new-socket" };
      const reloadView = {
        viewId: "new-document",
        generation: 1,
        threadIds: [threadId],
        background: false,
      };
      yield* temporaryThreads.updateViews(reloadIdentity, reloadView);
      if (anotherTab)
        yield* temporaryThreads.updateViews(
          { sessionId: "other-session", clientId: "other-socket" },
          { ...reloadView, viewId: "other-tab" },
        );
      yield* Scope.close(socketScope, Exit.void);
      yield* temporaryThreads.updateViews(reloadIdentity, {
        ...reloadView,
        generation: 2,
        threadIds: [],
      });
      yield* TestClock.adjust("29 seconds");
      assert.isTrue(yield* storage.isTemporary(threadId));
      yield* TestClock.adjust("1 second");
      assert.equal(yield* storage.isTemporary(threadId), anotherTab);
      if (anotherTab) {
        yield* temporaryThreads.updateViews(
          { sessionId: "other-session", clientId: "other-socket" },
          { ...reloadView, viewId: "other-tab", generation: 2, threadIds: [] },
        );
        assert.isFalse(yield* storage.isTemporary(threadId));
      }
    }).pipe(Effect.scoped),
);

it.effect(
  "preserves settings during discovery and keybindings during snapshot ACK at the config RPC boundary",
  () =>
    Effect.gen(function* () {
      const keybindings = yield* Keybindings.Keybindings;
      const settings = yield* ServerSettings.ServerSettingsService;
      const keybindingsSubscribed = yield* Deferred.make<void>();
      const settingsSubscribed = yield* Deferred.make<void>();
      const keybindingsChanges = keybindings.subscribeChanges.pipe(
        Effect.tap(() => Deferred.succeed(keybindingsSubscribed, undefined)),
      );
      const settingsChanges = settings.subscribeChanges.pipe(
        Effect.tap(() => Deferred.succeed(settingsSubscribed, undefined)),
      );
      const initialKeybindings = (yield* keybindings.getSnapshot).keybindings;
      const discoveryStarted = yield* Deferred.make<void>();
      const finishDiscovery = yield* Deferred.make<void>();
      const responses = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const configRpcServices = Layer.mergeAll(
        layerUnusedConfigRpcServices,
        Layer.mock(ExternalLauncher.ExternalLauncher)({
          resolveAvailableEditors: () =>
            Deferred.succeed(discoveryStarted, undefined).pipe(
              Effect.andThen(Deferred.await(finishDiscovery)),
              Effect.as([]),
            ),
          resolveFileManagerRevealKind: () => Effect.succeed(undefined),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          streamChanges: Stream.never,
        }),
        Layer.mock(UsageLimitSources.UsageLimitSources)({ streamChanges: Stream.make([]) }),
        Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({
          resolveTargets: () => Effect.succeed([]),
        }),
        Layer.mock(DirectEndpoints.DirectEndpoints)({ resolve: () => Effect.succeed([]) }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          scratchRoot: Effect.succeedNone,
          namedProjectsRoot: process.cwd(),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("config-test"),
            label: "Config test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          getDescriptor: () =>
            Effect.succeed({
              policy: "loopback-browser",
              bootstrapMethods: [],
              sessionMethods: ["browser-session-cookie"],
              sessionCookieName: "config-test-session",
            }),
        }),
        // Signal subscription on either accessor so the test also fails, rather
        // than hangs, against a handler that subscribes after the snapshot.
        Layer.succeed(Keybindings.Keybindings, {
          ...keybindings,
          streamChanges: Stream.unwrap(keybindingsChanges),
          subscribeChanges: keybindingsChanges,
        }),
        Layer.succeed(ServerSettings.ServerSettingsService, {
          ...settings,
          streamChanges: Stream.unwrap(settingsChanges),
          subscribeChanges: settingsChanges,
        }),
      );
      const server = yield* RpcServer.makeNoSerialization(
        RpcGroup.make(WsSubscribeServerConfigRpc),
        {
          ...WS_RPC_SERVER_OPTIONS,
          onFromServer: (response) =>
            response._tag === "Chunk"
              ? Effect.forEach(response.values, (event) => Queue.offer(responses, event), {
                  discard: true,
                })
              : Effect.void,
        },
      ).pipe(
        Effect.provide(
          layerWsRpc(
            {
              sessionId: AuthSessionId.make("config-test"),
              subject: "config-test",
              method: "browser-session-cookie",
              scopes: [],
            },
            {},
            {},
            yield* PreviewAutomationBroker.PreviewAutomationBroker,
            yield* ServerBrowser.ServerBrowser,
            yield* Effect.scope,
          ).pipe(Layer.provide(configRpcServices)),
        ),
      );
      const requestId = RpcMessage.RequestId("config");
      const acknowledge = server.write(0, { _tag: "Ack", requestId });
      yield* server.write(0, {
        _tag: "Request",
        id: requestId,
        tag: WS_METHODS.subscribeServerConfig,
        payload: {},
        headers: Headers.empty,
      });
      yield* Deferred.await(discoveryStarted);

      const duringDiscovery = yield* settings.updateSettings({ defaultAutoPull: true });
      yield* Deferred.succeed(finishDiscovery, undefined);
      const snapshot = yield* Queue.take(responses);
      assert.equal(snapshot.type, "snapshot");
      if (snapshot.type !== "snapshot") return yield* Effect.die("Missing initial snapshot");
      assert.isFalse(snapshot.config.settings.defaultAutoPull);
      assert.deepEqual(snapshot.config.keybindings, initialKeybindings);
      const duringAck = yield* keybindings.upsertKeybindingRule({
        key: "mod+alt+y",
        command: "terminal.toggle",
      });
      yield* acknowledge;
      yield* Deferred.await(keybindingsSubscribed);
      yield* Deferred.await(settingsSubscribed);

      // Later updates expose a dropped buffered event as a value mismatch, not a timeout.
      const latestSettings = yield* settings.updateSettings({ enableProviderUpdateChecks: false });
      const latestKeybindings = yield* keybindings.upsertKeybindingRule({
        key: "mod+alt+z",
        command: "terminal.split",
      });
      const expectedSettings = [duringDiscovery, latestSettings].map(
        ServerSettings.redactServerSettingsForClient,
      );
      const expectedKeybindings = [duringAck, latestKeybindings];
      // The two sources can interleave, but each must retain its own publication order.
      for (let i = 0; i < 4; i++) {
        const event = yield* Queue.take(responses);
        if (event.type === "settingsUpdated") {
          assert.deepEqual(event.payload.settings, expectedSettings.shift());
        } else {
          assert.equal(event.type, "keybindingsUpdated");
          if (event.type !== "keybindingsUpdated")
            return yield* Effect.die("Unexpected config event");
          assert.deepEqual(event.payload.keybindings, expectedKeybindings.shift());
          assert.deepEqual(event.payload.issues, []);
        }
        yield* acknowledge;
      }
      assert.isEmpty(expectedSettings);
      assert.isEmpty(expectedKeybindings);
      yield* server.write(0, { _tag: "Interrupt", requestId, interruptors: [] });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(layerConfigSources),
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ),
      ),
      Effect.scoped,
    ),
);

// Compaction keeps the oldest and newest event per message, so a cursor older
// than the deleted rows still replays each message where the client would
// first have seen it (reducers append on first sight) and reaches the same
// final state. No snapshot fallback is needed.
it.effect("thread resume across compacted history keeps message order and final state", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = "2026-10-13T00:00:00.000Z";
    const threadId = ThreadId.make("thread:compacted");
    const insertMessage = (version: number, id: string, text: string) => sql<{
      sequence: number;
    }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`compacted:${version}`}, 'thread', ${threadId}, ${version}, 'message.updated',
        ${now}, 'server', ${JSON.stringify({
          createdBy: "user",
          creationSource: "web",
          id,
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        })}, '{}', 2
      ) RETURNING sequence
    `;
    const [first] = yield* insertMessage(0, "message:a", "a created");
    const [second] = yield* insertMessage(1, "message:b", "b created");
    yield* insertMessage(2, "message:a", "a superseded");
    const [head] = yield* insertMessage(3, "message:a", "a final");
    // thread.deleted is never superseded: clients switch on the event type.
    for (const version of [0, 1]) {
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`deleted:${version}`}, 'thread', 'thread:deleted-twice', ${version}, 'thread.deleted',
          ${now}, 'server', '{}', '{}', 2
        )
      `;
    }
    assert.equal((yield* maintenance.compactEventStore).deletedEventCount, 1);

    const items = yield* subscribeOrchestrationV2Thread({
      threadId,
      afterSequence: first!.sequence - 1,
      requestCompletionMarker: true,
    }).pipe(
      Effect.flatMap((stream) =>
        stream.pipe(
          Stream.takeUntil((item) => item.kind === "synchronized"),
          Stream.runCollect,
        ),
      ),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        streamStoredEventsFrom: () => Stream.never,
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
    );
    assert.deepEqual(
      Array.from(items, (item) =>
        item.kind === "event"
          ? [item.sequence, item.event.type === "message.updated" ? item.event.payload.text : null]
          : [item.kind],
      ),
      [
        [first!.sequence, "a created"],
        [second!.sequence, "b created"],
        [head!.sequence, "a final"],
        ["synchronized"],
      ],
    );
  }).pipe(
    Effect.provide(
      ProjectionMaintenance.layer.pipe(
        Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
        Layer.provideMerge(ReplayTestLayer),
      ),
    ),
  ),
);
