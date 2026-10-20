import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId, type Project } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Broker from "./EnvironmentReadBroker.ts";
import * as Service from "./EnvironmentReadService.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const environmentId = EnvironmentId.make("local");
const remoteId = EnvironmentId.make("remote");
const owner = { sessionId: "client-session", socketId: "socket" };
const scope: McpInvocationScope = {
  environmentId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "read",
  thread: undefined,
  client: { sessionId: owner.sessionId, label: "Test", access: "read-only" },
};
const project: Project = {
  id: ProjectId.make("project"),
  title: "Local",
  workspaceRoot: "/work/local",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  deletedAt: null,
};
const layerBroker = Broker.layer.pipe(Layer.provide(NodeCrypto.layer));
const layerTest = Service.layer.pipe(
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.succeed({
        environmentId,
        label: "Local",
        serverVersion: "test",
        platform: { os: "linux", arch: "x64" },
        capabilities: { repositoryIdentity: false },
      }),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      snapshot: Effect.succeed({
        projects: [
          { ...project, id: ProjectId.make("deleted"), deletedAt: project.updatedAt },
          project,
        ],
        updatedAt: project.updatedAt,
      }),
      getById: (id) => Effect.succeed(id === project.id ? Option.some(project) : Option.none()),
    }),
  ),
  Layer.provide(Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({})),
  Layer.provideMerge(ThreadSearch.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  Layer.provideMerge(layerBroker),
);

it.layer(layerTest)("EnvironmentReadService", (it) => {
  it.effect("finds title-only matches when browsing and honors explicit title exclusion", () =>
    Effect.gen(function* () {
      const service = yield* Service.EnvironmentReadService;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("title-only");
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          ${project.id}, ${project.title}, ${project.workspaceRoot}, '[]',
          ${project.createdAt}, ${project.updatedAt}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        ) VALUES (
          ${threadId}, ${project.id}, 'needle title', 'codex', 'full-access', 'default',
          ${project.createdAt}, ${project.updatedAt}, '{}'
        )
      `;
      expect(
        yield* service.browse(scope, {
          request: { operation: "thread.search", query: "needle" },
        }),
      ).toEqual({
        environmentId,
        result: {
          operation: "thread.search",
          data: {
            matches: [
              {
                threadId,
                projectId: project.id,
                source: "title",
                snippet: "needle title",
                messageCreatedAt: null,
              },
            ],
            nextCursor: null,
          },
        },
      });
      expect(
        yield* service.browse(scope, {
          request: { operation: "thread.search", query: "needle", includeTitles: false },
        }),
      ).toEqual({
        environmentId,
        result: { operation: "thread.search", data: { matches: [], nextCursor: null } },
      });
    }),
  );

  it.effect(
    "defaults to local, filters before paging, and never falls back from a remote failure",
    () =>
      Effect.gen(function* () {
        const service = yield* Service.EnvironmentReadService;
        expect(yield* service.list(scope)).toEqual({
          environments: [{ environmentId, name: "Local", status: "online" }],
        });
        expect(
          yield* service.browse(scope, { request: { operation: "project.list", limit: 1 } }),
        ).toEqual({
          environmentId,
          result: { operation: "project.list", data: { projects: [project], nextCursor: null } },
        });
        expect(
          (yield* service
            .browse(scope, {
              environmentId: remoteId,
              request: { operation: "project.read", projectId: project.id },
            })
            .pipe(Effect.flip)).code,
        ).toBe("offline");
        expect(
          (yield* service
            .browse(
              { ...scope, environmentId: remoteId },
              { request: { operation: "project.list" } },
            )
            .pipe(Effect.flip)).code,
        ).toBe("permission-denied");
      }),
  );

  it.effect("reports ambiguous sharing while keeping local reads available", () =>
    Effect.gen(function* () {
      const service = yield* Service.EnvironmentReadService;
      const broker = yield* Broker.EnvironmentReadBroker;
      for (const session of [owner, { sessionId: "other-client", socketId: "other-socket" }]) {
        const ready = yield* Deferred.make<void>();
        yield* broker
          .connect(session, {
            clientId: "client",
            environments: [{ environmentId: remoteId, name: "Remote", status: "online" }],
          })
          .pipe(
            Stream.runForEach(() => Deferred.succeed(ready, undefined)),
            Effect.forkScoped,
          );
        yield* Deferred.await(ready);
      }
      const agentScope = { ...scope, client: undefined };
      expect((yield* service.list(agentScope).pipe(Effect.flip)).code).toBe("permission-denied");
      expect(yield* service.browse(agentScope, { request: { operation: "project.list" } })).toEqual(
        {
          environmentId,
          result: { operation: "project.list", data: { projects: [project], nextCursor: null } },
        },
      );
    }),
  );

  it.effect("routes a granted target through its client and returns its identity", () =>
    Effect.gen(function* () {
      const service = yield* Service.EnvironmentReadService;
      const broker = yield* Broker.EnvironmentReadBroker;
      const ready = yield* Deferred.make<void>();
      const remoteProject = { ...project, title: "Remote", workspaceRoot: "/work/remote" };
      yield* broker
        .connect(owner, {
          clientId: "client",
          environments: [{ environmentId: remoteId, name: "Remote", status: "online" }],
        })
        .pipe(
          Stream.runForEach((event) =>
            event.type === "connected"
              ? Deferred.succeed(ready, undefined)
              : broker.respond(owner, {
                  clientId: "client",
                  connectionId: event.connectionId,
                  requestId: event.requestId,
                  response: {
                    status: "ok",
                    result: { operation: "project.read", data: remoteProject },
                  },
                }),
          ),
          Effect.forkScoped,
        );
      yield* Deferred.await(ready);
      expect(
        yield* service.browse(scope, {
          environmentId: remoteId,
          request: { operation: "project.read", projectId: project.id },
        }),
      ).toEqual({
        environmentId: remoteId,
        result: { operation: "project.read", data: remoteProject },
      });
      expect((yield* service.list(scope)).environments).toHaveLength(2);
      expect(
        (yield* service.list({ ...scope, client: { ...scope.client!, sessionId: "other-client" } }))
          .environments,
      ).toHaveLength(1);
    }),
  );
});
