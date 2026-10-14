import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  IssueTrackerKind,
  type IssueTrackerProjectBinding,
  type OrchestrationProjectShell,
  ProjectId,
  type IssueViewerPermissions,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerApi,
  type StandaloneIssueTrackerApi,
  type TrackerIssueDetail,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as IssueService from "./IssueService.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const GITHUB = IssueTrackerKind.make("github");
const LINEAR = IssueTrackerKind.make("linear");
const JIRA = IssueTrackerKind.make("jira");
const permissions = {
  setState: true,
  comment: true,
  edit: true,
  labels: true,
  assignees: true,
} satisfies IssueViewerPermissions;

/** A standalone tracker shaped like Linear: its own host, team keys for scopes, `ENG-1` keys. */
function fakeStandaloneTracker(
  overrides: Partial<IssueTrackerApi> = {},
): StandaloneIssueTrackerApi {
  return {
    ...fakeTracker({
      getViewer: () => Effect.succeed("usr_julius"),
      getIssue: (input) =>
        Effect.succeed({ ...issue(input.key), displayKey: input.key, viewer: "usr_julius" }),
      ...overrides,
    }),
    kind: LINEAR,
    standalone: {
      tracker: LINEAR,
      displayName: "Linear",
      host: "linear.app",
      scopeNoun: "team",
      credential: { label: "Personal API key", helpUrl: null },
    },
    probeCredential: () => Effect.succeed({ account: "julius", scopes: [] }),
  };
}

function project(input: {
  readonly id: string;
  readonly repository?: string;
  readonly provider?: string;
  readonly host?: string;
}): OrchestrationProjectShell {
  const host = input.host ?? "github.com";
  return {
    id: input.id as ProjectId,
    title: input.id,
    workspaceRoot: `/w/${input.id}`,
    ...(input.repository
      ? {
          repositoryIdentity: {
            canonicalKey: `${host}/${input.repository}`,
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: `https://${host}/${input.repository}.git`,
            },
            provider: input.provider ?? "github",
            displayName: input.repository,
          },
        }
      : {}),
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
}

function issue(key: string, updatedAt = "2026-07-02T00:00:00Z"): TrackerIssueDetail {
  return {
    key,
    displayKey: `#${key}`,
    title: `Issue ${key}`,
    url: `https://github.com/acme/web/issues/${key}`,
    author: null,
    state: { category: "open", name: "open" },
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    body: "",
    viewer: "julius",
    viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
    comments: [],
    commentsCursor: null,
    events: [],
    linkedPullRequests: [],
  };
}

function fakeTracker(overrides: Partial<IssueTrackerApi> = {}): IssueTrackerApi {
  return {
    kind: GITHUB,
    capabilities: {
      create: true,
      edit: true,
      comment: true,
      labels: true,
      assignees: true,
      reactions: false,
      templates: false,
      linkedPullRequests: true,
      events: true,
      search: true,
      states: [
        { category: "open", name: "open" },
        { category: "closed", name: "closed" },
      ],
      closeReasons: ["completed"],
    },
    getViewer: () => Effect.succeed("julius"),
    listIssues: () => Effect.succeed({ items: [], nextCursor: null }),
    getIssue: (input) => Effect.succeed(issue(input.key)),
    getComments: () => Effect.succeed({ comments: [], nextCursor: null }),
    getViewerPermissions: () => Effect.succeed(permissions),
    comment: () => Effect.void,
    update: () => Effect.void,
    setState: () => Effect.void,
    ...overrides,
  };
}

function makeService(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly trackers: ReadonlyArray<IssueTrackerApi>;
  readonly bindings?: Record<string, IssueTrackerProjectBinding>;
  readonly resolveRepository?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"]["resolve"];
}) {
  return IssueService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(IssueTrackerBindings.IssueTrackerBindingsRepository)({
          list: Effect.sync(
            () =>
              new Map(
                Object.entries(input.bindings ?? {}).map(([id, binding]) => [
                  id as ProjectId,
                  binding,
                ]),
              ),
          ),
        }),
        Layer.succeed(
          IssueTrackerRegistry.IssueTrackerRegistry,
          IssueTrackerRegistry.fromTrackers(input.trackers),
        ),
        Layer.mock(ProjectService.ProjectService)({
          listShells: () => Effect.succeed(input.projects),
          getShell: (projectId) =>
            Effect.succeed(Option.fromNullishOr(input.projects.find((p) => p.id === projectId))),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve:
            input.resolveRepository ??
            ((cwd) =>
              Effect.succeed(
                input.projects.find((project) => project.workspaceRoot === cwd)
                  ?.repositoryIdentity ?? null,
              )),
        }),
      ),
    ),
  );
}

describe("resolveGitHostBinding", () => {
  it.each([
    { host: "acme.visualstudio.com", repository: "platform/_git/repo", scope: "acme/platform" },
    {
      host: "acme.visualstudio.com",
      repository: "DefaultCollection/My%20Project/_git/repo",
      scope: "acme/My Project",
    },
    { host: "dev.azure.com", repository: "acme/My%20Project/_git/repo", scope: "acme/My Project" },
    {
      host: "dev.azure.com",
      repository: "acme/My%2520Project/_git/repo",
      scope: "acme/My%20Project",
    },
  ])(
    "resolves native Azure project scope from $host/$repository",
    ({ host, repository, scope }) => {
      const original = project({ id: "p", provider: "azure-devops", host, repository });
      const identity = structuredClone(original.repositoryIdentity);
      expect(IssueService.resolveGitHostBinding(original)).toEqual({
        tracker: "azure-devops",
        host,
        scope,
      });
      expect(original.repositoryIdentity).toEqual(identity);
    },
  );

  it.each([
    "acme/My%2FProject/_git/repo",
    "acme/My%5CProject/_git/repo",
    "acme/My%ZZProject/_git/repo",
    "Ac%2Fme/project/_git/repo",
  ])("refuses invalid Azure scope encoding in %s", (repository) => {
    expect(
      IssueService.resolveGitHostBinding(
        project({ id: "p", provider: "azure-devops", host: "dev.azure.com", repository }),
      ),
    ).toBeNull();
  });
  it("scopes Azure DevOps work items to the project rather than the repository", () => {
    expect(
      IssueService.resolveGitHostBinding(
        project({
          id: "p",
          provider: "azure-devops",
          host: "dev.azure.com",
          repository: "acme/Web App/_git/web",
        }),
      ),
    ).toEqual({ tracker: "azure-devops", host: "dev.azure.com", scope: "acme/Web App" });
    expect(
      IssueService.resolveGitHostBinding(
        project({ id: "p", provider: "azure-devops", host: "dev.azure.com", repository: "web" }),
      ),
    ).toBeNull();
  });
});

describe("IssueService", () => {
  it.effect("reads another repository on the same host but refuses to write to it", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            comment: (input) =>
              Effect.sync(() => {
                writes.push(`${input.scope}#${input.key}`);
              }),
          }),
        ],
      });
      const own = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };
      const external = { ...own, scope: "other/backend", key: "7" };

      expect((yield* service.detail(own)).writable).toBe(true);
      // The external issue is served by the project's checkout and credentials, read-only.
      const detail = yield* service.detail(external);
      expect(detail).toMatchObject({ writable: false, scope: "other/backend", key: "7" });

      yield* service.comment({ ...own, body: "ok" });
      const refused = yield* Effect.flip(service.comment({ ...external, body: "no" }));
      expect(refused).toMatchObject({ _tag: "IssueOperationError", reason: "read-only" });
      expect(writes).toEqual(["acme/web#1"]);

      // Another host is not reachable through this project's credentials at all.
      const elsewhere = yield* Effect.flip(service.detail({ ...own, host: "ghe.example.test" }));
      expect(elsewhere).toMatchObject({
        _tag: "IssueUnavailableError",
        reason: "tracker-unsupported",
      });
    }),
  );

  it.effect("refuses what the tracker did not declare before calling it", () =>
    Effect.gen(function* () {
      let calls = 0;
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            setState: () =>
              Effect.sync(() => {
                calls += 1;
              }),
            setReaction: () =>
              Effect.sync(() => {
                calls += 1;
              }),
          }),
        ],
      });
      const ref = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };

      yield* service.setState({ ...ref, state: "closed", closeReason: "completed" });
      const unknownState = yield* Effect.flip(service.setState({ ...ref, state: "In Review" }));
      expect(unknownState._tag).toBe("IssueOperationError");
      const unknownReason = yield* Effect.flip(
        service.setState({ ...ref, state: "closed", closeReason: "not-planned" }),
      );
      expect(unknownReason._tag).toBe("IssueOperationError");
      const reaction = yield* Effect.flip(
        service.react({ ...ref, content: "heart", reacted: true }),
      );
      expect(reaction._tag).toBe("IssueOperationError");
      expect(calls).toBe(1);
    }),
  );

  it.effect("lists each repository once and reports unusable trackers per host", () =>
    Effect.gen(function* () {
      const listed: string[] = [];
      const service = yield* makeService({
        projects: [
          project({ id: "web", repository: "acme/web" }),
          project({ id: "web-worktree", repository: "acme/web" }),
          project({ id: "api", repository: "acme/api" }),
          project({ id: "gitlab", repository: "acme/gl", provider: "gitlab", host: "gitlab.com" }),
          project({ id: "plain" }),
        ],
        trackers: [
          fakeTracker({
            listIssues: (input) =>
              Effect.gen(function* () {
                listed.push(input.scope);
                if (input.scope === "acme/api")
                  return yield* new IssueTrackerError({
                    tracker: GITHUB,
                    operation: "listIssues",
                    reason: "failed",
                    detail: "boom",
                  });
                return {
                  items: [issue("2", "2026-07-05T00:00:00Z"), issue("1")],
                  nextCursor: "next",
                };
              }),
          }),
        ],
      });
      const result = yield* service.list({ state: "open" });
      expect(listed.sort()).toEqual(["acme/api", "acme/web"]);
      expect(result.entries.map((entry) => [entry.projectId, entry.key])).toEqual([
        ["web", "2"],
        ["web", "1"],
      ]);
      expect(result.nextCursors).toEqual({ "github.com acme/web": "next" });
      expect(result.errors).toEqual([
        {
          projectId: "api",
          projectTitle: "api",
          tracker: GITHUB,
          host: "github.com",
          message: "boom",
        },
      ]);
      expect(result.viewers).toEqual({ "github.com": "julius" });
      expect(result.trackers).toEqual([
        expect.objectContaining({ host: "github.com", projectCount: 3, configured: true }),
        expect.objectContaining({
          host: "gitlab.com",
          tracker: "gitlab",
          projectCount: 1,
          configured: false,
          capabilities: null,
        }),
      ]);

      // A continuation only reads the scopes it names.
      listed.length = 0;
      const next = yield* service.list({
        state: "open",
        cursors: { "github.com acme/web": "next" },
      });
      expect(listed).toEqual(["acme/web"]);
      expect(next.errors).toEqual([]);
    }),
  );
});

describe("IssueService with a standalone tracker", () => {
  it.effect("lists a bound project's standalone scope beside its git host and serves both", () =>
    Effect.gen(function* () {
      const listed: string[] = [];
      const record = (tracker: IssueTrackerKind): Partial<IssueTrackerApi> => ({
        listIssues: (input) =>
          Effect.sync(() => {
            listed.push(`${tracker} ${input.host} ${input.scope}`);
            return { items: [issue(tracker === LINEAR ? "ENG-1" : "1")], nextCursor: null };
          }),
      });
      const projects = [project({ id: "web", repository: "acme/web" }), project({ id: "notes" })];
      const trackers = [fakeTracker(record(GITHUB)), fakeStandaloneTracker(record(LINEAR))];
      const bound = yield* makeService({
        projects,
        trackers,
        bindings: { ["web" as ProjectId]: { tracker: LINEAR, scope: "ENG" } },
      });

      const result = yield* bound.list({ state: "open" });
      expect(listed.sort()).toEqual(["github github.com acme/web", "linear linear.app ENG"]);
      expect(result.entries.map((entry) => [entry.tracker, entry.scope, entry.key]).sort()).toEqual(
        [
          ["github", "acme/web", "1"],
          ["linear", "ENG", "ENG-1"],
        ],
      );
      expect(result.trackers.map((tracker) => [tracker.tracker, tracker.host]).sort()).toEqual([
        ["github", "github.com"],
        ["linear", "linear.app"],
      ]);
      // A reference picks the project's tracker by kind; both are the project's own, so writable.
      const linearRef = {
        projectId: "web" as ProjectId,
        tracker: LINEAR,
        scope: "ENG",
        key: "ENG-1",
      };
      expect(yield* bound.detail(linearRef)).toMatchObject({ host: "linear.app", writable: true });
      expect(
        yield* bound.detail({
          projectId: "web" as ProjectId,
          tracker: GITHUB,
          scope: "acme/web",
          key: "1",
        }),
      ).toMatchObject({ host: "github.com", writable: true });

      // Unbound, the standalone scope is gone and its references are unsupported.
      listed.length = 0;
      const unbound = yield* makeService({ projects, trackers });
      const after = yield* unbound.list({ state: "open" });
      expect(listed).toEqual(["github github.com acme/web"]);
      expect(after.trackers.map((tracker) => tracker.tracker)).toEqual(["github"]);
      const refused = yield* Effect.flip(unbound.detail(linearRef));
      expect(refused).toMatchObject({
        _tag: "IssueUnavailableError",
        reason: "tracker-unsupported",
      });

      // A project with no remote at all can still be bound, and then has only the standalone one.
      const standaloneOnly = yield* makeService({
        projects,
        trackers,
        bindings: { ["notes" as ProjectId]: { tracker: LINEAR, scope: "OPS" } },
      });
      const notes = yield* standaloneOnly.list({ state: "open", projectId: "notes" as ProjectId });
      expect(notes.entries.map((entry) => [entry.projectId, entry.scope])).toEqual([
        ["notes", "OPS"],
      ]);
    }),
  );
});

describe("IssueService write permissions", () => {
  it.effect.each([
    { field: "edit" as const, input: { title: "Changed" } },
    { field: "edit" as const, input: { body: "Changed" } },
    { field: "labels" as const, input: { labels: [] } },
    { field: "assignees" as const, input: { assignees: [] } },
    { field: "labels" as const, input: { title: "Changed", labels: [] } },
    { field: "assignees" as const, input: { labels: [], assignees: [] } },
  ])("checks fresh permission before updating $field", ({ field, input }) =>
    Effect.gen(function* () {
      let reads = 0;
      let writes = 0;
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            getViewerPermissions: () =>
              Effect.sync(() => {
                reads++;
                return { ...permissions, [field]: false };
              }),
            update: () =>
              Effect.sync(() => {
                writes++;
              }),
          }),
        ],
      });
      const ref = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };
      expect((yield* service.detail(ref)).viewerPermissions[field]).toBe(true);
      const denied = yield* Effect.flip(service.update({ ...ref, ...input }));
      expect(denied._tag).toBe("IssueOperationError");
      expect(reads).toBe(1);
      expect(writes).toBe(0);
    }),
  );

  it.effect.each(["comment", "setState"] as const)(
    "checks fresh %s permission before writing",
    (operation) =>
      Effect.gen(function* () {
        let reads = 0;
        let writes = 0;
        const write = () =>
          Effect.sync(() => {
            writes++;
          });
        const service = yield* makeService({
          projects: [project({ id: "web", repository: "acme/web" })],
          trackers: [
            fakeTracker({
              getViewerPermissions: () =>
                Effect.sync(() => {
                  reads++;
                  return { ...permissions, [operation]: false };
                }),
              comment: write,
              setState: write,
            }),
          ],
        });
        const ref = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };
        const denied = yield* Effect.flip(
          operation === "comment"
            ? service.comment({ ...ref, body: "Hello" })
            : service.setState({ ...ref, state: "closed" }),
        );
        expect(denied._tag).toBe("IssueOperationError");
        expect(reads).toBe(1);
        expect(writes).toBe(0);
      }),
  );

  it.effect("checks an update once and only needs permissions for its present fields", () =>
    Effect.gen(function* () {
      let reads = 0;
      let writes = 0;
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            getViewerPermissions: () =>
              Effect.sync(() => {
                reads++;
                return { ...permissions, edit: false, comment: false, setState: false };
              }),
            update: () =>
              Effect.sync(() => {
                writes++;
              }),
          }),
        ],
      });
      yield* service.update({
        projectId: "web" as ProjectId,
        tracker: GITHUB,
        scope: "acme/web",
        key: "1",
        labels: [],
        assignees: [],
      });
      expect(reads).toBe(1);
      expect(writes).toBe(1);
    }),
  );

  it.effect("preserves native permission probe failures without writing", () =>
    Effect.gen(function* () {
      let writes = 0;
      const error = new IssueTrackerError({
        tracker: GITHUB,
        operation: "getViewerPermissions",
        reason: "rate-limited",
        detail: "Try again later.",
        retryAt: 1234,
      });
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            getViewerPermissions: () => Effect.fail(error),
            update: () =>
              Effect.sync(() => {
                writes++;
              }),
          }),
        ],
      });
      const denied = yield* Effect.flip(
        service.update({
          projectId: "web" as ProjectId,
          tracker: GITHUB,
          scope: "acme/web",
          key: "1",
          title: "Changed",
        }),
      );
      expect(denied).toMatchObject({
        _tag: "IssueOperationError",
        reason: "rate-limited",
        detail: error.detail,
        retryAt: 1234,
        cause: error,
      });
      expect(writes).toBe(0);
    }),
  );

  it.effect("does not write through a standalone binding changed during permission lookup", () =>
    Effect.gen(function* () {
      let writes = 0;
      const bindings: Record<string, IssueTrackerProjectBinding> = {
        web: { tracker: LINEAR, scope: "ENG" },
      };
      const service = yield* makeService({
        projects: [project({ id: "web" })],
        bindings,
        trackers: [
          fakeStandaloneTracker({
            getViewerPermissions: () =>
              Effect.sync(() => {
                bindings.web = { tracker: LINEAR, scope: "OPS" };
                return permissions;
              }),
            update: () =>
              Effect.sync(() => {
                writes++;
              }),
          }),
        ],
      });
      const denied = yield* Effect.flip(
        service.update({
          projectId: "web" as ProjectId,
          tracker: LINEAR,
          scope: "ENG",
          key: "ENG-1",
          title: "Changed",
        }),
      );
      expect(denied).toMatchObject({ _tag: "IssueOperationError", reason: "read-only" });
      expect(writes).toBe(0);
    }),
  );
});

it.effect("shares the viewer probe per host within each list call", () =>
  Effect.gen(function* () {
    let reads = 0;
    const service = yield* makeService({
      projects: [
        project({ id: "web", repository: "acme/web" }),
        project({ id: "api", repository: "acme/api" }),
      ],
      trackers: [
        fakeTracker({
          getViewer: () =>
            Effect.yieldNow.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  reads++;
                  return "julius";
                }),
              ),
            ),
        }),
      ],
    });
    yield* service.list({ state: "open" });
    expect(reads).toBe(1);
    yield* service.list({ state: "open" });
    expect(reads).toBe(2);
  }),
);

it.effect("returns project sources without reading a tracker API", () =>
  Effect.gen(function* () {
    const unused = () => Effect.die("Sources must not probe providers");
    const service = yield* makeService({
      projects: [project({ id: "web", repository: "acme/web" })],
      bindings: { web: { tracker: LINEAR, scope: "ENG" } },
      trackers: [fakeTracker({ getViewer: unused }), fakeStandaloneTracker({ getViewer: unused })],
    });
    expect(yield* service.sources("web" as ProjectId)).toEqual([
      { tracker: GITHUB, host: "github.com", scope: "acme/web" },
      { tracker: LINEAR, host: "linear.app", scope: "ENG" },
    ]);
  }),
);

it.effect("refreshes a cached repository identity before a permitted write", () =>
  Effect.gen(function* () {
    let refreshes = 0;
    let writes = 0;
    const service = yield* makeService({
      projects: [project({ id: "web", repository: "acme/web" })],
      resolveRepository: (_cwd, options) =>
        Effect.sync(() => {
          expect(options?.refresh).toBe(true);
          refreshes++;
          return project({ id: "web", repository: "acme/api" }).repositoryIdentity ?? null;
        }),
      trackers: [
        fakeTracker({
          update: () =>
            Effect.sync(() => {
              writes++;
            }),
        }),
      ],
    });
    const denied = yield* Effect.flip(
      service.update({
        projectId: "web" as ProjectId,
        tracker: GITHUB,
        scope: "acme/web",
        key: "1",
        title: "Changed",
      }),
    );
    expect(denied).toMatchObject({ _tag: "IssueOperationError", reason: "read-only" });
    expect(refreshes).toBe(1);
    expect(writes).toBe(0);
  }),
);

it.effect("uses a standalone binding's verified site and refuses references to another site", () =>
  Effect.gen(function* () {
    let reads = 0;
    const base = fakeStandaloneTracker({
      getIssue: (input) =>
        Effect.sync(() => {
          reads++;
          expect(input.host).toBe("example.atlassian.net");
          return issue(input.key);
        }),
    });
    const api: StandaloneIssueTrackerApi = {
      ...base,
      kind: JIRA,
      standalone: { ...base.standalone, tracker: JIRA, host: null },
      probeCredential: () => Effect.die("Source resolution must not probe credentials"),
    };
    const service = yield* makeService({
      projects: [project({ id: "web" })],
      trackers: [api],
      bindings: { web: { tracker: JIRA, scope: "ENG", host: "example.atlassian.net" } },
    });
    expect(yield* service.sources("web" as ProjectId)).toEqual([
      { tracker: JIRA, scope: "ENG", host: "example.atlassian.net" },
    ]);
    const ref = { projectId: "web" as ProjectId, tracker: JIRA, scope: "ENG", key: "ENG-1" };
    expect(yield* service.detail({ ...ref, host: "example.atlassian.net" })).toMatchObject({
      writable: true,
    });
    expect(
      yield* Effect.flip(service.detail({ ...ref, host: "other.atlassian.net" })),
    ).toMatchObject({ _tag: "IssueUnavailableError" });
    expect(reads).toBe(1);
    const missingHost = yield* makeService({
      projects: [project({ id: "web" })],
      trackers: [api],
      bindings: { web: { tracker: JIRA, scope: "ENG" } },
    });
    expect(yield* missingHost.sources("web" as ProjectId)).toEqual([]);
  }),
);

it.effect(
  "offers and forwards a native issue type without requiring label or assignee support",
  () =>
    Effect.gen(function* () {
      const base = fakeTracker();
      let selected: string | undefined;
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            capabilities: {
              ...base.capabilities,
              labels: false,
              assignees: false,
              createIssueTypes: true,
            },
            listCandidates: () =>
              Effect.succeed({
                labels: [],
                assignees: [],
                issueTypes: [{ id: "10001", name: "Bug" }],
                truncated: false,
              }),
            create: (input) =>
              Effect.sync(() => {
                selected = input.issueType;
                return { key: "1", displayKey: "#1", url: "https://github.com/acme/web/issues/1" };
              }),
          }),
        ],
      });
      const ref = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web" };
      expect((yield* service.candidates(ref)).issueTypes).toEqual([{ id: "10001", name: "Bug" }]);
      yield* service.create({
        ...ref,
        title: "Fix",
        body: "",
        labels: [],
        assignees: [],
        issueType: "10001",
      });
      expect(selected).toBe("10001");
    }),
);

it.effect("refuses a selected issue type when the tracker does not support it", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [project({ id: "web", repository: "acme/web" })],
      trackers: [
        fakeTracker({ create: () => Effect.die("Unsupported type must not reach create") }),
      ],
    });
    const error = yield* Effect.flip(
      service.create({
        projectId: "web" as ProjectId,
        tracker: GITHUB,
        scope: "acme/web",
        title: "Fix",
        body: "",
        labels: [],
        assignees: [],
        issueType: "10001",
      }),
    );
    expect(error).toMatchObject({ _tag: "IssueOperationError" });
  }),
);

it.effect(
  "returns empty source facts and attributes failures to the actual tracker without extra reads",
  () =>
    Effect.gen(function* () {
      let viewerReads = 0;
      let listReads = 0;
      const api = fakeStandaloneTracker({
        getViewer: () =>
          Effect.sync(() => {
            viewerReads++;
            return "native-1";
          }),
        listIssues: () =>
          Effect.sync(() => {
            listReads++;
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new IssueTrackerError({
                  tracker: LINEAR,
                  operation: "list",
                  reason: "failed",
                  detail: "Team unavailable.",
                }),
              ),
            ),
          ),
      });
      const service = yield* makeService({
        projects: [project({ id: "web" })],
        trackers: [api],
        bindings: { web: { tracker: LINEAR, scope: "ENG" } },
      });
      const result = yield* service.list({ state: "open" });
      expect(result.entries).toEqual([]);
      expect(result.sources).toEqual([
        {
          projectId: "web",
          projectTitle: "web",
          tracker: LINEAR,
          host: "linear.app",
          scope: "ENG",
          capabilities: api.capabilities,
        },
      ]);
      expect(result.errors).toEqual([
        {
          projectId: "web",
          projectTitle: "web",
          tracker: LINEAR,
          host: "linear.app",
          message: "Team unavailable.",
        },
      ]);
      expect(viewerReads).toBe(1);
      expect(listReads).toBe(1);
    }),
);

it.effect(
  "refuses unsupported involvement before any native read while keeping older capabilities",
  () =>
    Effect.gen(function* () {
      for (const declared of [true, false]) {
        let reads = 0;
        const base = fakeTracker();
        const service = yield* makeService({
          projects: [project({ id: "web", repository: "acme/web" })],
          trackers: [
            fakeTracker({
              capabilities: {
                ...base.capabilities,
                ...(declared ? { involvements: ["all"] as const } : {}),
              },
              getViewer: () =>
                Effect.sync(() => {
                  reads++;
                  return "Alex";
                }),
              listIssues: () =>
                Effect.sync(() => {
                  reads++;
                  return { items: [], nextCursor: null };
                }),
            }),
          ],
        });
        const result = yield* service.list({ state: "open", involvement: "mentioned" });
        expect(reads).toBe(declared ? 0 : 2);
        expect(result.errors.length).toBe(declared ? 1 : 0);
        if (declared)
          expect(result.errors[0]).toMatchObject({ tracker: GITHUB, host: "github.com" });
      }
    }),
);

it.effect.each(["create", "react"] as const)(
  "refreshes cached repository ownership before %s",
  (operation) =>
    Effect.gen(function* () {
      let writes = 0;
      let refreshes = 0;
      const base = fakeTracker();
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        resolveRepository: (_cwd, options) =>
          Effect.sync(() => {
            expect(options?.refresh).toBe(true);
            refreshes++;
            return project({ id: "web", repository: "acme/api" }).repositoryIdentity ?? null;
          }),
        trackers: [
          fakeTracker({
            capabilities: { ...base.capabilities, reactions: true },
            create: () =>
              Effect.sync(() => {
                writes++;
                return { key: "2", displayKey: "#2", url: issue("2").url };
              }),
            setReaction: () =>
              Effect.sync(() => {
                writes++;
              }),
          }),
        ],
      });
      const ref = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };
      const denied = yield* Effect.flip(
        operation === "create"
          ? service.create({ ...ref, title: "New", body: "", labels: [], assignees: [] })
          : service.react({ ...ref, content: "heart", reacted: true }),
      );
      expect(denied).toMatchObject({ _tag: "IssueOperationError", reason: "read-only" });
      expect(refreshes).toBe(1);
      expect(writes).toBe(0);
    }),
);

it.effect.each(["create", "update"] as const)(
  "rejects too many assignees before native %s calls",
  (operation) =>
    Effect.gen(function* () {
      let reads = 0;
      let writes = 0;
      const base = fakeTracker();
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            capabilities: { ...base.capabilities, maxAssignees: 1 },
            getViewerPermissions: () =>
              Effect.sync(() => {
                reads++;
                return permissions;
              }),
            create: () =>
              Effect.sync(() => {
                writes++;
                return { key: "2", displayKey: "#2", url: issue("2").url };
              }),
            update: () =>
              Effect.sync(() => {
                writes++;
              }),
          }),
        ],
      });
      const ref = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };
      const denied = yield* Effect.flip(
        operation === "create"
          ? service.create({
              ...ref,
              title: "New",
              body: "",
              labels: [],
              assignees: ["alice", "bob"],
            })
          : service.update({ ...ref, assignees: ["alice", "bob"] }),
      );
      expect(denied._tag).toBe("IssueOperationError");
      expect(reads).toBe(0);
      expect(writes).toBe(0);
    }),
);

it.effect.each([{ assignees: [] }, { assignees: ["alice"] }])(
  "preserves valid assignee arrays, including clear: $assignees",
  ({ assignees }) =>
    Effect.gen(function* () {
      const written: ReadonlyArray<string>[] = [];
      const base = fakeTracker();
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            capabilities: { ...base.capabilities, maxAssignees: 1 },
            create: (input) =>
              Effect.sync(() => {
                written.push(input.assignees);
                return { key: "2", displayKey: "#2", url: issue("2").url };
              }),
            update: (input) =>
              Effect.sync(() => {
                written.push(input.assignees ?? []);
              }),
          }),
        ],
      });
      const ref = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };
      yield* service.create({ ...ref, title: "New", body: "", labels: [], assignees });
      yield* service.update({ ...ref, assignees });
      expect(written).toEqual([assignees, assignees]);
    }),
);

it.effect("resolves a canonical Linear scope without an extra issue read", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const service = yield* makeService({
      projects: [project({ id: "legacy" }), project({ id: "other" }), project({ id: "web" })],
      trackers: [
        fakeStandaloneTracker({
          listIssues: () => Effect.die("URL resolution must not list issues"),
          getIssue: (input) =>
            Effect.sync(() => {
              calls.push(`read ${input.scope}`);
              return { ...issue(input.key), url: "https://linear.app/acme/issue/ENG-123/title" };
            }),
          comment: (input) =>
            Effect.sync(() => {
              calls.push(`comment ${input.scope}`);
            }),
          setState: (input) =>
            Effect.sync(() => {
              calls.push(`state ${input.scope}`);
            }),
        }),
      ],
      bindings: {
        legacy: { tracker: LINEAR, scope: "ENG" },
        other: { tracker: LINEAR, scope: "other/ENG" },
        web: { tracker: LINEAR, scope: "acme/ENG" },
      },
    });
    const ref = yield* service.resolveUrl(
      "https://linear.app/Acme/issue/ENG-123/title",
      ProjectId.make("legacy"),
    );
    expect(ref).toEqual({
      projectId: "web",
      tracker: LINEAR,
      host: "linear.app",
      scope: "acme/ENG",
      key: "ENG-123",
      writable: true,
    });
    expect(calls).toEqual([]);
    expect(yield* service.detail(ref)).toMatchObject({ writable: true, scope: "acme/ENG" });
    yield* service.comment({ ...ref, body: "Hello" });
    yield* service.setState({ ...ref, state: "closed" });
    expect(calls).toEqual(["read acme/ENG", "comment acme/ENG", "state acme/ENG"]);
  }),
);

it.effect(
  "rejects stale Linear refs after a canonical workspace binding replaces a bare team",
  () =>
    Effect.gen(function* () {
      const service = yield* makeService({
        projects: [project({ id: "web" })],
        trackers: [
          fakeStandaloneTracker({
            getIssue: () => Effect.die("Stale refs must not read issues"),
            getComments: () => Effect.die("Stale refs must not read comments"),
            getViewerPermissions: () => Effect.die("Stale refs must not read permissions"),
            comment: () => Effect.die("Stale refs must not write comments"),
          }),
        ],
        bindings: { web: { tracker: LINEAR, scope: "new-workspace/ENG" } },
      });
      for (const scope of ["ENG", "old-workspace/ENG"]) {
        const ref = { projectId: ProjectId.make("web"), tracker: LINEAR, scope, key: "ENG-123" };
        for (const operation of [
          service.detail(ref),
          service.comments({ ...ref, cursor: "next" }),
          service.comment({ ...ref, body: "Hello" }),
        ]) {
          expect(yield* Effect.flip(operation)).toMatchObject({ _tag: "IssueUnavailableError" });
        }
      }
      expect(
        yield* Effect.flip(service.resolveUrl("https://linear.app/old-workspace/issue/ENG-123")),
      ).toMatchObject({ _tag: "IssueUnavailableError" });
    }),
);

it.effect("resolves another Linear team's URL in the bound workspace read-only", () =>
  Effect.gen(function* () {
    const reads: string[] = [];
    const service = yield* makeService({
      projects: [project({ id: "web" })],
      trackers: [
        fakeStandaloneTracker({
          getIssue: (input) => {
            expect(input.scope.toLowerCase()).toBe("acme/qa");
            reads.push(input.scope);
            return Effect.succeed(issue(input.key));
          },
          getViewerPermissions: () => Effect.die("Foreign team writes must not read permissions"),
          comment: () => Effect.die("Foreign team must not write comments"),
        }),
      ],
      bindings: { web: { tracker: LINEAR, scope: "acme/ENG" } },
    });
    const ref = {
      projectId: ProjectId.make("web"),
      tracker: LINEAR,
      scope: "Acme/QA",
      key: "QA-123",
    };
    expect(yield* service.detail(ref)).toMatchObject({
      writable: false,
    });
    expect(yield* Effect.flip(service.comment({ ...ref, body: "Hello" }))).toMatchObject({
      _tag: "IssueOperationError",
      reason: "read-only",
    });
    const resolved = yield* service.resolveUrl("https://linear.app/acme/issue/QA-123/title");
    expect(resolved).toEqual({
      projectId: "web",
      tracker: LINEAR,
      host: "linear.app",
      scope: "acme/qa",
      key: "QA-123",
      writable: false,
    });
    expect(reads).toEqual(["Acme/QA"]);
    expect(yield* service.detail(resolved)).toMatchObject({ writable: false });
    expect(yield* Effect.flip(service.comment({ ...resolved, body: "Hello" }))).toMatchObject({
      _tag: "IssueOperationError",
      reason: "read-only",
    });
    expect(
      yield* Effect.flip(service.resolveUrl("https://linear.app/other-workspace/issue/QA-123")),
    ).toMatchObject({ _tag: "IssueUnavailableError" });
    expect(reads).toEqual(["Acme/QA", "acme/qa"]);
  }),
);

it.effect("resolves a legacy Linear team binding and verifies the native workspace", () =>
  Effect.gen(function* () {
    let reads = 0;
    const writes: string[] = [];
    const api = fakeStandaloneTracker({
      listIssues: () => Effect.die("URL resolution must not list issues"),
      getIssue: (input) =>
        Effect.sync(() => {
          reads++;
          expect(input.scope).toBe("ENG");
          return { ...issue(input.key), url: "https://linear.app/acme/issue/ENG-123/native-title" };
        }),
      comment: (input) =>
        Effect.sync(() => {
          writes.push(`comment ${input.scope} ${input.key}`);
        }),
      setState: (input) =>
        Effect.sync(() => {
          writes.push(`state ${input.scope} ${input.key}`);
        }),
    });
    const service = yield* makeService({
      projects: [project({ id: "other" }), project({ id: "web" })],
      trackers: [api],
      bindings: { other: { tracker: LINEAR, scope: "QA" }, web: { tracker: LINEAR, scope: "ENG" } },
    });
    const ref = yield* service.resolveUrl(
      "https://linear.app/acme/issue/ENG-123/older-title",
      ProjectId.make("other"),
    );
    expect(ref).toEqual({
      projectId: "web",
      tracker: LINEAR,
      host: "linear.app",
      scope: "ENG",
      key: "ENG-123",
      writable: true,
    });
    yield* service.comment({ ...ref, body: "Hello" });
    yield* service.setState({ ...ref, state: "closed" });
    expect(writes).toEqual(["comment ENG ENG-123", "state ENG ENG-123"]);
    expect(
      yield* Effect.flip(
        service.resolveUrl("https://linear.app/another-workspace/issue/ENG-123/title"),
      ),
    ).toMatchObject({ _tag: "IssueOperationError", reason: "not-found" });
    expect(reads).toBe(2);
  }),
);

it.effect(
  "resolves Jira URL refs with same-site foreign project reads and writes only on the bound project",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      const writes: string[] = [];
      const base = fakeStandaloneTracker({
        listIssues: () => Effect.die("URL resolution must not list issues"),
        getIssue: (input) =>
          Effect.sync(() => {
            reads++;
            expect(input.host).toBe("tenant.atlassian.net");
            expect(input.scope).toBe(input.key.split("-")[0]);
            return { ...issue(input.key), url: `https://tenant.atlassian.net/browse/${input.key}` };
          }),
        comment: (input) =>
          Effect.sync(() => {
            writes.push(`comment ${input.scope} ${input.key}`);
          }),
        setState: (input) =>
          Effect.sync(() => {
            writes.push(`state ${input.scope} ${input.key}`);
          }),
      });
      const api: StandaloneIssueTrackerApi = {
        ...base,
        kind: JIRA,
        standalone: { ...base.standalone, tracker: JIRA, host: null },
      };
      const service = yield* makeService({
        projects: [project({ id: "web" })],
        trackers: [api],
        bindings: { web: { tracker: JIRA, scope: "ENG", host: "tenant.atlassian.net" } },
      });
      const ref = yield* service.resolveUrl(
        "https://tenant.atlassian.net/browse/ENG-123?focusedCommentId=1",
      );
      expect(ref).toEqual({
        projectId: "web",
        tracker: JIRA,
        host: "tenant.atlassian.net",
        scope: "ENG",
        key: "ENG-123",
        writable: true,
      });
      expect(reads).toBe(0);
      yield* service.detail(ref);
      yield* service.comment({ ...ref, body: "Hello" });
      yield* service.setState({ ...ref, state: "closed" });
      expect(writes).toEqual(["comment ENG ENG-123", "state ENG ENG-123"]);
      const foreign = yield* service.resolveUrl("https://tenant.atlassian.net/browse/OPS-1");
      expect(foreign).toEqual({
        projectId: "web",
        tracker: JIRA,
        host: "tenant.atlassian.net",
        scope: "OPS",
        key: "OPS-1",
        writable: false,
      });
      expect(reads).toBe(1);
      expect(yield* service.detail(foreign)).toMatchObject({ writable: false });
      for (const operation of [
        service.comment({ ...foreign, body: "Hello" }),
        service.setState({ ...foreign, state: "closed" }),
      ]) {
        expect(yield* Effect.flip(operation)).toMatchObject({
          _tag: "IssueOperationError",
          reason: "read-only",
        });
      }
      for (const url of [
        "https://other.atlassian.net/browse/ENG-123",
        "https://other.atlassian.net/browse/OPS-1",
      ]) {
        expect(yield* Effect.flip(service.resolveUrl(url))).toMatchObject({
          _tag: "IssueUnavailableError",
        });
      }
      expect(reads).toBe(2);
      expect(writes).toEqual(["comment ENG ENG-123", "state ENG ENG-123"]);
      const unbound = yield* makeService({ projects: [project({ id: "web" })], trackers: [api] });
      expect(
        yield* Effect.flip(unbound.resolveUrl("https://tenant.atlassian.net/browse/OPS-1")),
      ).toMatchObject({ _tag: "IssueUnavailableError" });
    }),
);

it.effect("does not lend a standalone project's credentials to an unbound team", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [project({ id: "web" })],
      trackers: [
        fakeStandaloneTracker({ getIssue: () => Effect.die("Unbound team must not read") }),
      ],
      bindings: { web: { tracker: LINEAR, scope: "ENG" } },
    });
    expect(
      yield* Effect.flip(service.resolveUrl("https://linear.app/acme/issue/QA-123/title")),
    ).toMatchObject({ _tag: "IssueUnavailableError" });
  }),
);

it.effect(
  "recognizes a configured GitHub Enterprise hostname and keeps foreign repositories read-only",
  () =>
    Effect.gen(function* () {
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web", host: "git.acme.test" })],
        trackers: [
          fakeTracker({ listIssues: () => Effect.die("URL resolution must not list issues") }),
        ],
      });
      expect(yield* service.resolveUrl("https://git.acme.test/acme/web/issues/7")).toEqual({
        projectId: "web",
        tracker: GITHUB,
        host: "git.acme.test",
        scope: "acme/web",
        key: "7",
        writable: true,
      });
      expect(yield* service.resolveUrl("https://git.acme.test/acme/other/issues/7")).toMatchObject({
        scope: "acme/other",
        writable: false,
      });
      expect(
        yield* Effect.flip(service.resolveUrl("https://other.acme.test/acme/web/issues/7")),
      ).toMatchObject({ _tag: "IssueOperationError", reason: "not-found" });
    }),
);

it.effect("keeps a GitLab HTTP remote's port when its canonical repository key omits it", () =>
  Effect.gen(function* () {
    const gitlab = IssueTrackerKind.make("gitlab");
    const shell = project({
      id: "web",
      repository: "acme/web",
      host: "gitlab.company.test",
      provider: "gitlab",
    });
    const repositoryIdentity = shell.repositoryIdentity!;
    const configured = {
      ...shell,
      repositoryIdentity: {
        ...repositoryIdentity,
        locator: {
          ...repositoryIdentity.locator,
          remoteUrl: "https://gitlab.company.test:8443/acme/web.git",
        },
      },
    };
    const listed: string[] = [];
    const service = yield* makeService({
      projects: [configured],
      trackers: [
        fakeTracker({
          kind: gitlab,
          listIssues: (input) =>
            Effect.sync(() => {
              listed.push(input.host);
              return { items: [], nextCursor: null };
            }),
          getIssue: () => Effect.die("URL resolution must not read issues"),
        }),
      ],
    });
    expect(yield* service.list({ state: "open", projectId: shell.id })).toMatchObject({
      sources: [{ projectId: "web", host: "gitlab.company.test:8443", scope: "acme/web" }],
    });
    expect(listed).toEqual(["gitlab.company.test:8443"]);
    expect(
      yield* service.resolveUrl("https://gitlab.company.test:8443/acme/web/-/issues/7"),
    ).toMatchObject({
      projectId: "web",
      host: "gitlab.company.test:8443",
      scope: "acme/web",
      writable: true,
    });
    expect(
      yield* service.resolveUrl("https://gitlab.company.test:8443/acme/other/-/issues/7"),
    ).toMatchObject({
      projectId: "web",
      host: "gitlab.company.test:8443",
      scope: "acme/other",
      writable: false,
    });
    for (const host of ["gitlab.company.test", "gitlab.company.test:9443"]) {
      expect(
        yield* Effect.flip(service.resolveUrl(`https://${host}/acme/web/-/issues/7`)),
      ).toMatchObject({ _tag: "IssueUnavailableError" });
    }
    expect(configured.repositoryIdentity.canonicalKey).toBe("gitlab.company.test/acme/web");
  }),
);

it.effect.each([
  { tracker: "github", path: "/issues/7" },
  { tracker: "gitlab", path: "/-/issues/7" },
  { tracker: "forgejo", path: "/issues/7" },
])(
  "resolves custom ports for $tracker without lending another install's source",
  ({ tracker, path }) =>
    Effect.gen(function* () {
      const kind = IssueTrackerKind.make(tracker);
      const service = yield* makeService({
        projects: [
          project({
            id: "web",
            repository: "acme/web",
            host: "git.acme.test:3000",
            provider: tracker,
          }),
          project({
            id: "other",
            repository: "acme/web",
            host: "git.acme.test:4000",
            provider: tracker,
          }),
        ],
        trackers: [
          fakeTracker({
            kind,
            getIssue: () => Effect.die("URL resolution must not read issues"),
            listIssues: () => Effect.die("URL resolution must not list issues"),
          }),
        ],
      });
      for (const [port, projectId] of [
        ["3000", "web"],
        ["4000", "other"],
      ] as const) {
        expect(
          yield* service.resolveUrl(
            `https://git.acme.test:${port}/acme/web${path}`,
            ProjectId.make("other"),
          ),
        ).toEqual({
          projectId,
          tracker: kind,
          host: `git.acme.test:${port}`,
          scope: "acme/web",
          key: "7",
          writable: true,
        });
        expect(
          yield* service.resolveUrl(`https://git.acme.test:${port}/acme/foreign${path}`),
        ).toMatchObject({
          projectId,
          host: `git.acme.test:${port}`,
          scope: "acme/foreign",
          writable: false,
        });
      }
      expect(
        yield* Effect.flip(service.resolveUrl(`https://git.acme.test:5000/acme/web${path}`)),
      ).toMatchObject({
        _tag: tracker === "gitlab" ? "IssueUnavailableError" : "IssueOperationError",
      });
    }),
);

it.effect("matches a Git host's normalized default HTTPS port", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({
          id: "web",
          repository: "acme/web",
          host: "git.acme.test:443",
          provider: "forgejo",
        }),
      ],
      trackers: [
        fakeTracker({
          kind: IssueTrackerKind.make("forgejo"),
          getIssue: () => Effect.die("URL resolution must not read issues"),
        }),
      ],
    });
    expect(yield* service.resolveUrl("https://git.acme.test:443/acme/web/issues/7")).toMatchObject({
      projectId: "web",
      host: "git.acme.test",
      writable: true,
    });
  }),
);

it.effect("resolves a configured Forgejo source before a GitHub-looking hostname", () =>
  Effect.gen(function* () {
    const forgejo = IssueTrackerKind.make("forgejo");
    const service = yield* makeService({
      projects: [
        project({
          id: "web",
          repository: "acme/web",
          host: "github.company.net",
          provider: "forgejo",
        }),
      ],
      trackers: [
        fakeTracker({
          kind: forgejo,
          listIssues: () => Effect.die("URL resolution must not list issues"),
        }),
      ],
    });
    expect(yield* service.resolveUrl("https://github.company.net/acme/web/issues/7")).toEqual({
      projectId: "web",
      tracker: forgejo,
      host: "github.company.net",
      scope: "acme/web",
      key: "7",
      writable: true,
    });
  }),
);

it.effect.each([
  {
    host: "dev.azure.com",
    repository: "acme/My%20Project/_git/repo",
    url: "https://dev.azure.com/acme/My%20Project/_workitems/edit/7",
  },
  {
    host: "acme.visualstudio.com",
    repository: "My%20Project/_git/repo",
    url: "https://acme.visualstudio.com/My%20Project/_workitems/edit/7",
  },
  {
    host: "acme.visualstudio.com",
    repository: "DefaultCollection/My%20Project/_git/repo",
    url: "https://acme.visualstudio.com/DefaultCollection/My%20Project/_workitems/edit/7",
  },
])(
  "uses the decoded Azure project for list, detail, writes and URL refs from $host/$repository",
  ({ host, repository, url }) =>
    Effect.gen(function* () {
      const azure = IssueTrackerKind.make("azure-devops");
      const scopes: string[] = [];
      const service = yield* makeService({
        projects: [project({ id: "web", provider: "azure-devops", host, repository })],
        trackers: [
          fakeTracker({
            kind: azure,
            listIssues: (input) =>
              Effect.sync(() => {
                scopes.push(input.scope);
                return { items: [{ ...issue("7"), url }], nextCursor: null };
              }),
            getIssue: (input) =>
              Effect.sync(() => {
                scopes.push(input.scope);
                return { ...issue(input.key), url };
              }),
            update: (input) =>
              Effect.sync(() => {
                scopes.push(input.scope);
              }),
          }),
        ],
      });
      const listed = yield* service.list({ state: "open" });
      expect(listed.entries[0]).toMatchObject({ tracker: azure, host, scope: "acme/My Project" });
      const ref = yield* service.resolveUrl(url);
      expect(ref).toMatchObject({
        tracker: azure,
        host,
        scope: "acme/My Project",
        key: "7",
        writable: true,
      });
      expect(yield* service.detail(ref)).toMatchObject({
        writable: true,
        scope: "acme/My Project",
      });
      yield* service.update({ ...ref, title: "Changed" });
      expect(scopes).toEqual(["acme/My Project", "acme/My Project", "acme/My Project"]);
    }),
);
