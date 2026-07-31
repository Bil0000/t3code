import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {
  OrchestrationProjectShell,
  ProjectId,
  PullRequestReviewCapabilities,
  SourceControlProviderKind,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import { PullRequestProviderRegistry, fromProviders } from "./PullRequestProviderRegistry.ts";
import * as PullRequestService from "./PullRequestService.ts";

function project(input: {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repository?: string;
  readonly provider?: string;
  readonly host?: string;
}): OrchestrationProjectShell {
  // The host defaults from the provider, so a fixture only names one when the point of the
  // test is two hosts of the same kind.
  const host = input.host ?? (input.provider === "gitlab" ? "gitlab.com" : "github.com");
  return {
    id: input.id as ProjectId,
    title: input.title,
    workspaceRoot: input.workspaceRoot,
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

function changeRequest(number: number, updatedAt: string): ProviderChangeRequest {
  return {
    number,
    title: `Change request ${number}`,
    url: `https://host/pull/${number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `feat/${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    reviewRequestLogins: [],
    labels: [],
  };
}

function unusable(provider: SourceControlProviderKind, reason: "missing-tool" | "unauthenticated") {
  return new PullRequestProviderError({
    provider,
    operation: "getViewer",
    reason,
    detail: `${provider} is not usable.`,
  });
}

const requestFailed = new PullRequestProviderError({
  provider: "github",
  operation: "listChangeRequests",
  reason: "failed",
  detail: "HTTP 404",
});

/** Everything a host could offer, so a fixture only narrows what its own test is about. */
const FULL_REVIEW: PullRequestReviewCapabilities = {
  inlineComment: true,
  reply: true,
  resolve: true,
  verdicts: ["comment", "approve", "request-changes"],
};

/** A provider whose every call is supplied by the test; anything unset succeeds emptily. */
function fakeProvider(
  kind: SourceControlProviderKind,
  overrides: Partial<PullRequestProviderApi> = {},
): PullRequestProviderApi {
  return {
    kind,
    capabilities: {
      diff: true,
      comment: true,
      actions: ["merge", "ready", "draft", "close", "reopen"],
      mergeMethods: ["merge"],
      review: FULL_REVIEW,
    },
    getViewer: () => Effect.succeed("bilal"),
    listChangeRequests: () => Effect.succeed({ items: [], truncated: false }),
    getChangeRequest: () => Effect.die("unused"),
    getDiff: () => Effect.die("unused"),
    runAction: () => Effect.void,
    comment: () => Effect.void,
    submitReview: () => Effect.void,
    replyToThread: () => Effect.void,
    setThreadResolution: () => Effect.void,
    ...overrides,
  };
}

function makeService(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly providers: ReadonlyArray<PullRequestProviderApi>;
}) {
  return PullRequestService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(PullRequestProviderRegistry, fromProviders(input.providers)),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: input.projects,
              threads: [],
              updatedAt: "2026-07-01T00:00:00Z",
            }),
        }),
      ),
    ),
  );
}

it.effect("reads nothing from a host with no implementation, but reports it", () =>
  Effect.gen(function* () {
    const listed: string[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({ id: "p2", title: "notes", workspaceRoot: "/b" }),
        project({
          id: "p3",
          title: "on gitlab",
          workspaceRoot: "/c",
          repository: "group/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: (input) => {
            listed.push(input.repository);
            return Effect.succeed({
              items: [changeRequest(1, "2026-07-02T00:00:00Z")],
              truncated: false,
            });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(listed, ["pingdotgg/t3code"]);
    assert.strictEqual(result.entries[0]?.provider, "github");
    // The GitLab project is explained rather than quietly missing from the page.
    assert.deepStrictEqual(
      result.providers.map((summary) => ({
        kind: summary.kind,
        configured: summary.configured,
        projectCount: summary.projectCount,
      })),
      [
        { kind: "github", configured: true, projectCount: 1 },
        { kind: "gitlab", configured: false, projectCount: 1 },
      ],
    );
  }),
);

it.effect("calls a transient viewer failure a failed operation, not a signed-out CLI", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          getViewer: () =>
            Effect.fail(
              new PullRequestProviderError({
                provider: "github",
                operation: "getViewer",
                reason: "failed",
                detail: "HTTP 500",
              }),
            ),
        }),
      ],
    });

    const error = yield* Effect.flip(service.list({ state: "open" }));

    // `cli-unauthenticated` would send the reader to `gh auth login` over a transient error.
    assert.strictEqual(error._tag, "PullRequestOperationError");
  }),
);

it.effect("reports an unusable host over a merely failing one", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({
          id: "p2",
          title: "on gitlab",
          workspaceRoot: "/c",
          repository: "group/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("github", {
          getViewer: () =>
            Effect.fail(
              new PullRequestProviderError({
                provider: "github",
                operation: "getViewer",
                reason: "failed",
                detail: "HTTP 500",
              }),
            ),
        }),
        fakeProvider("gitlab", {
          getViewer: () => Effect.fail(unusable("gitlab", "missing-tool")),
        }),
      ],
    });

    const error = yield* Effect.flip(service.list({ state: "open" }));

    assert.strictEqual(error._tag, "PullRequestUnavailableError");
    assert.strictEqual(error.message.includes("glab"), true);
  }),
);

it.effect("lists every host that has an implementation", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({
          id: "p2",
          title: "on gitlab",
          workspaceRoot: "/b",
          repository: "group/sub/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: () =>
            Effect.succeed({
              items: [changeRequest(1, "2026-07-01T00:00:00Z")],
              truncated: false,
            }),
        }),
        fakeProvider("gitlab", {
          listChangeRequests: (input) =>
            // Nested groups need the full path, not the last two segments.
            input.repository === "group/sub/project"
              ? Effect.succeed({
                  items: [changeRequest(2, "2026-07-05T00:00:00Z")],
                  truncated: false,
                })
              : Effect.die("wrong repository identity"),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(
      result.entries.map((entry) => [entry.provider, entry.number]),
      [
        ["gitlab", 2],
        ["github", 1],
      ],
    );
  }),
);

it.effect("narrows the listing to one host when asked", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({
          id: "p2",
          title: "on gitlab",
          workspaceRoot: "/b",
          repository: "group/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("github", { listChangeRequests: () => Effect.die("should not be read") }),
        fakeProvider("gitlab", {
          listChangeRequests: () =>
            Effect.succeed({
              items: [changeRequest(2, "2026-07-05T00:00:00Z")],
              truncated: false,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open", provider: "gitlab" });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.provider),
      ["gitlab"],
    );
  }),
);

it.effect("keeps one host listed when another is not set up", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({
          id: "p2",
          title: "on gitlab",
          workspaceRoot: "/b",
          repository: "group/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: () =>
            Effect.succeed({
              items: [changeRequest(1, "2026-07-01T00:00:00Z")],
              truncated: false,
            }),
        }),
        fakeProvider("gitlab", {
          getViewer: () => Effect.fail(unusable("gitlab", "missing-tool")),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.provider),
      ["github"],
    );
    assert.deepStrictEqual(
      result.providers.map((summary) => [summary.kind, summary.configured]),
      [
        ["github", true],
        ["gitlab", false],
      ],
    );
  }),
);

it.effect("fails as unavailable only when no host can be read", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          getViewer: () => Effect.fail(unusable("github", "missing-tool")),
        }),
      ],
    });

    const error = yield* service.list({ state: "open" }).pipe(Effect.flip);

    assert.strictEqual(error._tag, "PullRequestUnavailableError");
    assert.strictEqual(
      error._tag === "PullRequestUnavailableError" ? error.reason : null,
      "cli-missing",
    );
  }),
);

it.effect("reads a repository once when several worktrees share it", () =>
  Effect.gen(function* () {
    let calls = 0;
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({
          id: "p2",
          title: "t3code worktree",
          workspaceRoot: "/b",
          repository: "PingDotGG/T3Code",
        }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: () => {
            calls += 1;
            return Effect.succeed({
              items: [changeRequest(1, "2026-07-02T00:00:00Z")],
              truncated: false,
            });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.strictEqual(calls, 1);
    assert.strictEqual(result.entries.length, 1);
  }),
);

it.effect("keeps healthy repositories when one of them cannot be read", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({ id: "p2", title: "broken", workspaceRoot: "/b", repository: "pingdotgg/broken" }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: (input) =>
            input.repository === "pingdotgg/broken"
              ? Effect.fail(requestFailed)
              : Effect.succeed({
                  items: [changeRequest(1, "2026-07-02T00:00:00Z")],
                  truncated: false,
                }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.strictEqual(result.entries.length, 1);
    assert.deepStrictEqual(
      result.errors.map((error) => error.projectTitle),
      ["broken"],
    );
  }),
);

it.effect("tries another workspace on the same host for the viewer", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "broken", workspaceRoot: "/broken", repository: "acme/one" }),
        project({ id: "p2", title: "healthy", workspaceRoot: "/healthy", repository: "acme/two" }),
      ],
      providers: [
        fakeProvider("github", {
          getViewer: (input) =>
            input.cwd === "/healthy"
              ? Effect.succeed("bilal")
              : Effect.fail(unusable("github", "missing-tool")),
          listChangeRequests: () =>
            Effect.succeed({
              items: [changeRequest(1, "2026-07-02T00:00:00Z")],
              truncated: false,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.strictEqual(result.entries.length, 2);
    assert.strictEqual(result.viewers["github.com"], "bilal");
  }),
);

it.effect("refuses an action the host never claimed it could run", () =>
  Effect.gen(function* () {
    let ran = false;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          capabilities: {
            diff: true,
            comment: true,
            // Bitbucket's shape: it can merge and close, but cannot reopen.
            actions: ["merge", "close"],
            mergeMethods: ["merge"],
            review: FULL_REVIEW,
          },
          runAction: () => {
            ran = true;
            return Effect.void;
          },
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.runAction({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        action: "reopen",
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.isFalse(ran);
  }),
);

it.effect("refuses a comment on a host that cannot post one", () =>
  Effect.gen(function* () {
    let posted = false;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          capabilities: {
            diff: false,
            comment: false,
            actions: ["merge"],
            mergeMethods: ["merge"],
            review: FULL_REVIEW,
          },
          comment: () => {
            posted = true;
            return Effect.void;
          },
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.comment({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        body: "Looks good.",
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.isFalse(posted);
  }),
);

it.effect("keeps two hosts of one provider kind as two accounts", () =>
  Effect.gen(function* () {
    const viewerFor: Record<string, string> = { "/cloud": "bilal", "/enterprise": "b.hassan" };
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "cloud", workspaceRoot: "/cloud", repository: "acme/web" }),
        project({
          id: "p2",
          title: "enterprise",
          workspaceRoot: "/enterprise",
          // The same path on a different host: neither the viewer nor the row may be shared.
          repository: "acme/web",
          host: "github.acme.dev",
        }),
      ],
      providers: [
        fakeProvider("github", {
          getViewer: (input) => Effect.succeed(viewerFor[input.cwd] ?? "unknown"),
          listChangeRequests: () =>
            Effect.succeed({
              items: [changeRequest(1, "2026-07-02T00:00:00Z")],
              truncated: false,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    // Both repositories survive de-duplication, each with its own account.
    assert.strictEqual(result.entries.length, 2);
    assert.deepStrictEqual(result.viewers, {
      "github.com": "bilal",
      "github.acme.dev": "b.hassan",
    });
    assert.deepStrictEqual(result.entries.map((entry) => entry.host).toSorted(), [
      "github.acme.dev",
      "github.com",
    ]);
  }),
);

it.effect("reports repositories on a host that could not be read", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "cloud", workspaceRoot: "/cloud", repository: "acme/web" }),
        project({
          id: "p2",
          title: "enterprise",
          workspaceRoot: "/enterprise",
          repository: "acme/api",
          host: "github.acme.dev",
        }),
      ],
      providers: [
        fakeProvider("github", {
          getViewer: (input) =>
            input.cwd === "/cloud"
              ? Effect.succeed("bilal")
              : Effect.fail(unusable("github", "unauthenticated")),
          listChangeRequests: () =>
            Effect.succeed({
              items: [changeRequest(1, "2026-07-02T00:00:00Z")],
              truncated: false,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    // The healthy host still lists, and the unreadable one is named rather than dropped.
    assert.strictEqual(result.entries.length, 1);
    assert.deepStrictEqual(
      result.errors.map((error) => error.projectId),
      ["p2"],
    );
  }),
);

it.effect("flags a review request for the viewer but not on their own change request", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: () =>
            Effect.succeed({
              items: [
                { ...changeRequest(1, "2026-07-02T00:00:00Z"), reviewRequestLogins: ["Bilal"] },
                {
                  ...changeRequest(2, "2026-07-02T00:00:00Z"),
                  author: { login: "bilal", name: null, avatarUrl: null },
                  reviewRequestLogins: ["bilal"],
                },
              ],
              truncated: false,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.viewerReviewRequested),
      [true, false],
    );
  }),
);

it.effect("refuses a repository that does not belong to the requested project", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [fakeProvider("github")],
    });

    const error = yield* service
      .diff({ projectId: "p1" as ProjectId, repository: "attacker/repo", number: 1 })
      .pipe(Effect.flip);

    assert.strictEqual(error._tag, "PullRequestOperationError");
  }),
);

it.effect("refuses a diff on a host that cannot produce one", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "on azure",
          workspaceRoot: "/a",
          repository: "org/project",
          provider: "azure-devops",
        }),
      ],
      providers: [
        fakeProvider("azure-devops", {
          capabilities: {
            diff: false,
            comment: true,
            actions: ["merge", "close"],
            mergeMethods: ["merge"],
            review: FULL_REVIEW,
          },
          getDiff: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* service
      .diff({ projectId: "p1" as ProjectId, repository: "org/project", number: 1 })
      .pipe(Effect.flip);

    assert.strictEqual(error._tag, "PullRequestOperationError");
  }),
);

it.effect("rejects an empty comment before reaching the host", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [fakeProvider("github", { comment: () => Effect.die("must not be called") })],
    });

    const error = yield* service
      .comment({
        projectId: "p1" as ProjectId,
        repository: "pingdotgg/t3code",
        number: 1,
        body: "   ",
      })
      .pipe(Effect.flip);

    assert.strictEqual(error._tag, "PullRequestOperationError");
  }),
);

it.effect("refuses a verdict the host never claimed, without asking the provider", () =>
  Effect.gen(function* () {
    let submitted = false;
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "on gitlab",
          workspaceRoot: "/a",
          repository: "group/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("gitlab", {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge"],
            mergeMethods: ["merge"],
            // GitLab's shape: it approves, and has nothing that rejects.
            review: {
              inlineComment: true,
              reply: true,
              resolve: true,
              verdicts: ["comment", "approve"],
            },
          },
          submitReview: () => {
            submitted = true;
            return Effect.void;
          },
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.submitReview({
        projectId: "p1" as ProjectId,
        repository: "group/project",
        number: 1,
        verdict: "request-changes",
        body: "no",
        comments: [],
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.isFalse(submitted);
  }),
);

it.effect("refuses line comments on a host that takes only a summary", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge"],
            mergeMethods: ["merge"],
            review: { inlineComment: false, reply: false, resolve: false, verdicts: ["comment"] },
          },
          submitReview: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.submitReview({
        projectId: "p1" as ProjectId,
        repository: "pingdotgg/t3code",
        number: 1,
        verdict: "comment",
        body: "",
        comments: [{ path: "src/a.ts", line: 1, side: "right", body: "nit" }],
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
  }),
);

it.effect(
  "refuses a review with neither a summary nor a comment, but lets an approval through",
  () =>
    Effect.gen(function* () {
      let approved = false;
      const service = yield* makeService({
        projects: [
          project({
            id: "p1",
            title: "t3code",
            workspaceRoot: "/a",
            repository: "pingdotgg/t3code",
          }),
        ],
        providers: [
          fakeProvider("github", {
            submitReview: () => {
              approved = true;
              return Effect.void;
            },
          }),
        ],
      });
      const reference = {
        projectId: "p1" as ProjectId,
        repository: "pingdotgg/t3code",
        number: 1,
      };

      const error = yield* Effect.flip(
        service.submitReview({ ...reference, verdict: "comment", body: "   ", comments: [] }),
      );
      assert.strictEqual(error._tag, "PullRequestOperationError");

      // An approval is a verdict in itself, so it needs no words.
      yield* service.submitReview({ ...reference, verdict: "approve", body: "", comments: [] });
      assert.isTrue(approved);
    }),
);

it.effect("refuses to resolve a conversation on a host that cannot", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge"],
            mergeMethods: ["merge"],
            review: { inlineComment: true, reply: false, resolve: false, verdicts: ["comment"] },
          },
          setThreadResolution: () => Effect.die("must not be called"),
          replyToThread: () => Effect.die("must not be called"),
        }),
      ],
    });
    const reference = {
      projectId: "p1" as ProjectId,
      repository: "pingdotgg/t3code",
      number: 1,
    };

    const resolveError = yield* Effect.flip(
      service.setThreadResolution({ ...reference, threadId: "t1", resolved: true }),
    );
    const replyError = yield* Effect.flip(
      service.replyToThread({ ...reference, threadId: "t1", body: "hi" }),
    );

    assert.strictEqual(resolveError._tag, "PullRequestOperationError");
    assert.strictEqual(replyError._tag, "PullRequestOperationError");
  }),
);

it.effect("refuses an empty reply before it reaches the host", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", { replyToThread: () => Effect.die("must not be called") }),
      ],
    });

    const error = yield* Effect.flip(
      service.replyToThread({
        projectId: "p1" as ProjectId,
        repository: "pingdotgg/t3code",
        number: 1,
        threadId: "t1",
        body: "   ",
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
  }),
);

it.effect("refuses a merge strategy the host does not offer", () =>
  Effect.gen(function* () {
    let ranWith: string | null = null;
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge"],
            // Azure DevOps's shape: it squashes as a completion option and has no rebase.
            mergeMethods: ["merge", "squash"],
            review: FULL_REVIEW,
          },
          runAction: (input) => {
            ranWith = input.mergeMethod ?? "merge";
            return Effect.void;
          },
        }),
      ],
    });
    const reference = {
      projectId: "p1" as ProjectId,
      repository: "pingdotgg/t3code",
      number: 1,
    };

    // Every provider maps an unrecognised strategy to its own default, so letting this through
    // would merge with the wrong one rather than fail.
    const error = yield* Effect.flip(
      service.runAction({ ...reference, action: "merge", mergeMethod: "rebase" }),
    );
    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.strictEqual(ranWith, null);

    yield* service.runAction({ ...reference, action: "merge", mergeMethod: "squash" });
    assert.strictEqual(ranWith, "squash");
  }),
);

it.effect("hands the provider the host its repository lives on", () =>
  Effect.gen(function* () {
    const hosts: string[] = [];
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "enterprise",
          workspaceRoot: "/a",
          repository: "acme/web",
          host: "github.acme.dev",
        }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: (input) => {
            hosts.push(input.host);
            return Effect.succeed({ items: [], truncated: false });
          },
        }),
      ],
    });

    yield* service.list({ state: "open" });

    // The identity a project records is the path below its host, so the host has to travel
    // separately or a GitHub Enterprise repository is read off github.com instead.
    assert.deepStrictEqual(hosts, ["github.acme.dev"]);
  }),
);
