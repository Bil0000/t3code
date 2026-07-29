import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";
import type { GitHubPullRequestListItem } from "./gitHubPullRequestJson.ts";
import * as PullRequestService from "./PullRequestService.ts";

function project(input: {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repository?: string;
  readonly provider?: string;
}): OrchestrationProjectShell {
  const [owner, name] = (input.repository ?? "/").split("/");
  return {
    id: input.id as ProjectId,
    title: input.title,
    workspaceRoot: input.workspaceRoot,
    ...(input.repository
      ? {
          repositoryIdentity: {
            canonicalKey: `github.com/${input.repository}`,
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: `https://github.com/${input.repository}.git`,
            },
            provider: input.provider ?? "github",
            owner: owner!,
            name: name!,
          },
        }
      : {}),
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
}

function listItem(number: number, updatedAt: string): GitHubPullRequestListItem {
  return {
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/pingdotgg/t3code/pull/${number}`,
    author: { login: "octocat", name: null },
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

function makeService(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly github: Partial<GitHubPullRequestCli.GitHubPullRequestCli["Service"]>;
}) {
  return PullRequestService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
          getViewerLogin: () => Effect.succeed("bilal"),
          ...input.github,
        }),
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

const cliUnavailable = new GitHubCli.GitHubCliUnavailableError({
  command: "gh",
  cwd: "/repo",
  cause: new Error("spawn gh ENOENT"),
});

const cliFailed = new GitHubCli.GitHubCliCommandError({
  command: "gh",
  cwd: "/repo",
  cause: new Error("HTTP 404"),
});

it.effect("lists only projects backed by a GitHub repository", () =>
  Effect.gen(function* () {
    const listed: string[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({ id: "p2", title: "notes", workspaceRoot: "/b" }),
        project({
          id: "p3",
          title: "gitlab thing",
          workspaceRoot: "/c",
          repository: "group/project",
          provider: "gitlab",
        }),
      ],
      github: {
        listPullRequests: (input) => {
          listed.push(input.repository);
          return Effect.succeed({ items: [listItem(1, "2026-07-02T00:00:00Z")], truncated: false });
        },
      },
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(listed, ["pingdotgg/t3code"]);
    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.entries[0]?.projectTitle, "t3code");
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
      github: {
        listPullRequests: () => {
          calls += 1;
          return Effect.succeed({ items: [listItem(1, "2026-07-02T00:00:00Z")], truncated: false });
        },
      },
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
      github: {
        listPullRequests: (input) =>
          input.repository === "pingdotgg/broken"
            ? Effect.fail(cliFailed)
            : Effect.succeed({
                items: [listItem(1, "2026-07-02T00:00:00Z")],
                truncated: false,
              }),
      },
    });

    const result = yield* service.list({ state: "open" });

    assert.strictEqual(result.entries.length, 1);
    assert.deepStrictEqual(
      result.errors.map((error) => error.projectTitle),
      ["broken"],
    );
  }),
);

it.effect("reports a missing CLI as unavailable rather than a per-project error", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      github: { listPullRequests: () => Effect.fail(cliUnavailable) },
    });

    const error = yield* service.list({ state: "open" }).pipe(Effect.flip);

    assert.strictEqual(error._tag, "PullRequestUnavailableError");
    assert.strictEqual(
      error._tag === "PullRequestUnavailableError" ? error.reason : null,
      "cli-missing",
    );
  }),
);

it.effect("orders entries by most recently updated across repositories", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "one", workspaceRoot: "/a", repository: "pingdotgg/one" }),
        project({ id: "p2", title: "two", workspaceRoot: "/b", repository: "pingdotgg/two" }),
      ],
      github: {
        listPullRequests: (input) =>
          Effect.succeed({
            items: [
              input.repository === "pingdotgg/one"
                ? listItem(1, "2026-07-01T00:00:00Z")
                : listItem(2, "2026-07-05T00:00:00Z"),
            ],
            truncated: false,
          }),
      },
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [2, 1],
    );
  }),
);

it.effect("flags a review request for the viewer but not on their own pull request", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      github: {
        listPullRequests: () =>
          Effect.succeed({
            items: [
              { ...listItem(1, "2026-07-02T00:00:00Z"), reviewRequestLogins: ["Bilal"] },
              {
                ...listItem(2, "2026-07-02T00:00:00Z"),
                author: { login: "bilal", name: null },
                reviewRequestLogins: ["bilal"],
              },
            ],
            truncated: false,
          }),
      },
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
      github: {
        getPullRequestDetail: () => Effect.die("must not reach GitHub"),
      },
    });

    const error = yield* service
      .diff({ projectId: "p1" as ProjectId, repository: "attacker/repo", number: 1 })
      .pipe(Effect.flip);

    assert.strictEqual(error._tag, "PullRequestOperationError");
  }),
);
