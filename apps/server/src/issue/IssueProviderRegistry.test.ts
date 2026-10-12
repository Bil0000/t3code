import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  issueSourceKey,
  SourceControlProviderKind,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@t3tools/contracts";

import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import type { IssueAdapter } from "./IssueProvider.ts";
import { fromProviders } from "./IssueProviderRegistry.ts";

const sourceControlLayer = Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
  resolveLink: () => Effect.die("unused"),
  resolveHandle: () => Effect.succeed({ provider: undefined as never, context: null }),
});

const PROJECT: OrchestrationProjectShell = {
  id: "p1" as ProjectId,
  title: "web",
  workspaceRoot: "/work/web",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

it.effect("binds a project to an issue adapter without source-control types", () =>
  Effect.gen(function* () {
    const jira = {
      kind: "jira",
      resolveSource: () => Effect.succeed({ host: "acme.atlassian.net", repository: "ACME" }),
    } as unknown as IssueAdapter;
    const registry = yield* fromProviders([jira]).pipe(Effect.provide(sourceControlLayer));

    const result = yield* registry.resolveProjects([PROJECT], {});

    assert.strictEqual(result.supported.length, 1);
    assert.strictEqual(result.supported[0]?.adapter, jira);
    assert.deepStrictEqual(
      result.supported.map(({ host, repository }) => ({ host, repository })),
      [{ host: "acme.atlassian.net", repository: "ACME" }],
    );
    assert.deepStrictEqual(
      result.viewerRoots,
      new Map([[issueSourceKey("jira", "acme.atlassian.net"), ["/work/web"]]]),
    );
  }),
);

it.effect("keeps two adapters that share one host and repository", () =>
  Effect.gen(function* () {
    const sourceProject: OrchestrationProjectShell = {
      ...PROJECT,
      repositoryIdentity: {
        canonicalKey: "tracker.example.test/acme/web",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://tracker.example.test/acme/web.git",
        },
        provider: "github",
        displayName: "acme/web",
      },
    };
    const github = { kind: "github" } as unknown as IssueAdapter;
    const jira = {
      kind: "jira",
      resolveSource: (candidate: OrchestrationProjectShell) =>
        Effect.succeed(
          candidate.id === "p2" ? { host: "tracker.example.test", repository: "acme/web" } : null,
        ),
    } as unknown as IssueAdapter;
    const registry = yield* fromProviders([github, jira]).pipe(Effect.provide(sourceControlLayer));

    const result = yield* registry.resolveProjects(
      [
        sourceProject,
        { ...PROJECT, id: "p2" as ProjectId, title: "planning", workspaceRoot: "/planning" },
      ],
      {},
    );

    assert.deepStrictEqual(result.supported.map(({ adapter }) => adapter.kind).toSorted(), [
      "github",
      "jira",
    ]);
  }),
);

it.effect("keeps source-control and external issue sources for one project", () =>
  Effect.gen(function* () {
    const project: OrchestrationProjectShell = {
      ...PROJECT,
      repositoryIdentity: {
        canonicalKey: "github.com/acme/web",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/acme/web.git",
        },
        provider: "github",
        displayName: "acme/web",
      },
    };
    const github = { kind: "github" } as unknown as IssueAdapter;
    const linear = {
      kind: "linear",
      resolveSource: () => Effect.succeed({ host: "linear.app", repository: "ENG" }),
    } as unknown as IssueAdapter;
    const registry = yield* fromProviders([github, linear]).pipe(
      Effect.provide(sourceControlLayer),
    );

    const result = yield* registry.resolveProjects([project], {});

    assert.deepStrictEqual(
      result.supported
        .map(({ adapter, host, repository }) => ({ kind: adapter.kind, host, repository }))
        .toSorted((left, right) => left.kind.localeCompare(right.kind)),
      [
        { kind: "github", host: "github.com", repository: "acme/web" },
        { kind: "linear", host: "linear.app", repository: "ENG" },
      ],
    );
  }),
);

it.effect("keeps account-bound sources distinct on linear.app", () =>
  Effect.gen(function* () {
    const linear = {
      kind: "linear",
      resolveSource: (candidate: OrchestrationProjectShell) =>
        Effect.succeed({
          host: "linear.app",
          repository: candidate.id === "p1" ? "ENG" : "OPS",
          credentialId: candidate.id === "p1" ? "user-1" : "user-2",
        }),
    } as unknown as IssueAdapter;
    const registry = yield* fromProviders([linear]).pipe(Effect.provide(sourceControlLayer));

    const result = yield* registry.resolveProjects(
      [PROJECT, { ...PROJECT, id: "p2" as ProjectId, workspaceRoot: "/work/api" }],
      {},
    );

    assert.deepStrictEqual(
      result.supported.map(({ credentialId, repository }) => [credentialId, repository]),
      [
        ["user-1", "ENG"],
        ["user-2", "OPS"],
      ],
    );
    assert.strictEqual(result.viewerRoots.size, 2);
    assert.deepStrictEqual([...result.viewerRoots.values()].flat().toSorted(), [
      "/work/api",
      "/work/web",
    ]);
  }),
);

it.effect("derives a self-hosted hostname from a legacy remote identity", () =>
  Effect.gen(function* () {
    const project: OrchestrationProjectShell = {
      ...PROJECT,
      repositoryIdentity: {
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://code.example.test/group/project.git",
        },
        provider: "gitlab",
        displayName: "group/project",
      } as unknown as OrchestrationProjectShell["repositoryIdentity"],
    };
    const registry = yield* fromProviders([{ kind: "gitlab" } as unknown as IssueAdapter]).pipe(
      Effect.provide(sourceControlLayer),
    );

    const result = yield* registry.resolveProjects([project], {});

    assert.strictEqual(result.supported[0]?.host, "code.example.test");
  }),
);

it.effect("refines one unknown remote before de-duplicating its worktrees", () =>
  Effect.gen(function* () {
    let refinementCalls = 0;
    const selfHosted: OrchestrationProjectShell = {
      ...PROJECT,
      repositoryIdentity: {
        canonicalKey: "code.example.test/group/project",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://code.example.test/group/project.git",
        },
        provider: "unknown",
        displayName: "group/project",
      } as unknown as OrchestrationProjectShell["repositoryIdentity"],
    };
    const sourceControl = SourceControlProviderRegistry.SourceControlProviderRegistry.of({
      resolveLink: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      resolve: () => Effect.die("unused"),
      discover: Effect.die("unused"),
      resolveHandle: ({ context }) => {
        refinementCalls += 1;
        return Effect.succeed({
          provider: undefined as never,
          context: {
            ...context!,
            provider: { ...context!.provider, kind: SourceControlProviderKind.make("gitlab") },
          },
        });
      },
    });
    const gitlab = { kind: "gitlab" } as unknown as IssueAdapter;
    const registry = yield* fromProviders([gitlab]).pipe(
      Effect.provideService(
        SourceControlProviderRegistry.SourceControlProviderRegistry,
        sourceControl,
      ),
    );

    const result = yield* registry.resolveProjects(
      [selfHosted, { ...selfHosted, id: "p2" as ProjectId, workspaceRoot: "/worktree" }],
      { host: "code.example.test" },
    );

    assert.strictEqual(refinementCalls, 1);
    assert.strictEqual(result.supported.length, 1);
    assert.strictEqual(result.supported[0]?.adapter, gitlab);
    assert.deepStrictEqual(
      result.viewerRoots,
      new Map([[issueSourceKey("gitlab", "code.example.test"), ["/work/web", "/worktree"]]]),
    );
  }),
);

it.effect("routes account management by provider and rejects unsupported trackers", () =>
  Effect.gen(function* () {
    const tracker = {
      status: Effect.succeed({
        status: "authenticated",
        hasStoredToken: false,
        accountName: null,
        accountEmail: null,
        projects: [],
        accounts: [],
      } as const),
      connect: () => Effect.die("unused"),
      disconnect: () => Effect.die("unused"),
      bind: () => Effect.void,
    };
    const registry = yield* fromProviders([
      { kind: "jira", tracker } as unknown as IssueAdapter,
    ]).pipe(Effect.provide(sourceControlLayer));
    const resolved = yield* registry.tracker("jira", "status");
    assert.strictEqual((yield* resolved.status).status, "authenticated");
    const error = yield* Effect.flip(registry.tracker("github", "connect"));
    assert.strictEqual(error.operation, "connect");
    assert.include(error.detail, "not supported for github");
  }),
);

it.effect("resolves configured hosts without guessing the caller's provider", () =>
  Effect.gen(function* () {
    const github = { kind: "github" } as unknown as IssueAdapter;
    const registry = yield* fromProviders([github]).pipe(Effect.provide(sourceControlLayer));
    const reference = {
      projectId: PROJECT.id,
      repository: "external/repo",
      number: 7,
      provider: "github" as const,
      url: "https://private.example.test/external/repo/issues/7",
    };
    const rejected = yield* registry
      .resolveUrl({ reference, project: PROJECT, sources: [] })
      .pipe(Effect.flip);
    assert.strictEqual(rejected._tag, "IssueOperationError");
    const resolved = yield* registry.resolveUrl({
      reference,
      project: PROJECT,
      sources: [
        { project: PROJECT, adapter: github, host: "private.example.test", repository: "acme/web" },
      ],
    });
    assert.strictEqual(resolved.project, PROJECT);
    assert.strictEqual(resolved.host, "private.example.test");
    assert.strictEqual(resolved.repository, "external/repo");
  }),
);

it.effect("uses one connected Linear account without a project binding and refuses ambiguity", () =>
  Effect.gen(function* () {
    const account = {
      credentialId: "account-1",
      status: "authenticated" as const,
      accountName: "Account",
      accountEmail: null,
      projects: [{ id: "team", key: "ENG", name: "Engineering" }],
    };
    let accounts = [account];
    const linear = {
      kind: "linear",
      tracker: {
        get status() {
          return Effect.succeed({
            status: "authenticated",
            hasStoredToken: true,
            accountName: "Account",
            accountEmail: null,
            projects: account.projects,
            accounts,
          });
        },
      },
    } as unknown as IssueAdapter;
    const registry = yield* fromProviders([linear]).pipe(Effect.provide(sourceControlLayer));
    const reference = {
      projectId: PROJECT.id,
      repository: "ENG",
      number: 7,
      url: "https://linear.app/acme/issue/ENG-7",
    };
    const resolved = yield* registry.resolveUrl({ reference, project: PROJECT, sources: [] });
    assert.strictEqual(resolved.credentialId, "account-1");
    accounts = [account, { ...account, credentialId: "account-2" }];
    assert.strictEqual(
      (yield* registry.resolveUrl({ reference, project: PROJECT, sources: [] }).pipe(Effect.flip))
        ._tag,
      "IssueOperationError",
    );
    const bound = yield* registry.resolveUrl({
      reference,
      project: PROJECT,
      sources: [
        {
          project: PROJECT,
          adapter: linear,
          repository: "ENG",
          host: "linear.app",
          credentialId: "account-2",
        },
      ],
    });
    assert.strictEqual(bound.credentialId, "account-2");
  }),
);

it.effect("uses the actual owning project when a full URL matches its bound source", () =>
  Effect.gen(function* () {
    const github = { kind: "github" } as unknown as IssueAdapter;
    const owner = { ...PROJECT, id: "owner" as ProjectId, workspaceRoot: "/owner" };
    const registry = yield* fromProviders([github]).pipe(Effect.provide(sourceControlLayer));
    const result = yield* registry.resolveUrl({
      project: PROJECT,
      reference: {
        projectId: PROJECT.id,
        repository: "acme/web",
        number: 7,
        url: "https://github.com/acme/web/issues/7",
      },
      sources: [{ project: owner, adapter: github, host: "github.com", repository: "acme/web" }],
    });
    assert.strictEqual(result.project, owner);
    assert.strictEqual(result.projectBound, true);
  }),
);

it.effect.each(["dev.azure.com", "acme.visualstudio.com"])(
  "matches Azure organization aliases and project checkouts on %s",
  (host) =>
    Effect.gen(function* () {
      const azure = { kind: "azure-devops" } as unknown as IssueAdapter;
      const registry = yield* fromProviders([azure]).pipe(Effect.provide(sourceControlLayer));
      const owner = { ...PROJECT, id: "owner" as ProjectId };
      const reference = {
        projectId: PROJECT.id,
        repository: "acme/team",
        number: 7,
        url: "https://acme.visualstudio.com/DefaultCollection/team/_workitems/edit/7",
      };
      const resolve = (repository: string) =>
        registry.resolveUrl({
          project: PROJECT,
          reference,
          sources: [{ project: owner, adapter: azure, host, repository }],
        });
      const bound = yield* resolve("acme/team/_git/repo");
      assert.strictEqual(bound.project, owner);
      assert.strictEqual(bound.projectBound, true);
      assert.strictEqual(bound.repository, reference.repository);
      const exact = yield* registry.resolveUrl({
        project: PROJECT,
        reference: { ...reference, repository: "acme/team/_git/repo" },
        sources: [{ project: owner, adapter: azure, host, repository: "acme/team/_git/repo" }],
      });
      assert.strictEqual(exact.project, owner);
      assert.strictEqual(exact.repository, "acme/team/_git/repo");
      for (const repository of ["other/team/_git/repo", "acme/other/_git/repo"]) {
        const unbound = yield* resolve(repository);
        assert.strictEqual(unbound.project, PROJECT);
        assert.strictEqual(unbound.projectBound, false);
      }
    }),
);
