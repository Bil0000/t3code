import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as GitHub from "./GitHubPullRequestProvider.ts";
import * as GitLab from "./GitLabPullRequestProvider.ts";
import * as Bitbucket from "./BitbucketPullRequestProvider.ts";
import * as Azure from "./AzureDevOpsPullRequestProvider.ts";
import * as GitHubCli from "./GitHubPullRequestCli.ts";
import * as GitLabCli from "./GitLabPullRequestCli.ts";
import * as BitbucketApi from "./BitbucketPullRequestApi.ts";
import * as AzureCli from "./AzureDevOpsPullRequestCli.ts";
import { assertSourceBranchDeletable } from "./pullRequestBranchDeletion.ts";

it.effect("allows only finished pull requests and refuses both protected branch identities", () =>
  Effect.gen(function* () {
    const input = {
      state: "merged",
      sourceBranch: "feat/change",
      baseBranch: "release",
      defaultBranch: "main",
    };
    yield* assertSourceBranchDeletable(input);
    yield* assertSourceBranchDeletable({ ...input, state: "closed" });
    yield* assertSourceBranchDeletable({ ...input, state: "SUPERSEDED" });
    for (const state of ["open", "active", "unknown"]) {
      const error = yield* Effect.flip(assertSourceBranchDeletable({ ...input, state }));
      expect(error.detail).toContain("Close or merge");
    }
    for (const sourceBranch of ["main", "release"]) {
      const error = yield* Effect.flip(assertSourceBranchDeletable({ ...input, sourceBranch }));
      expect(error.detail).toContain("cannot be deleted");
    }
  }),
);

it.effect(
  "advertises branch deletion without adding an unknown action to legacy capability arrays",
  () =>
    Effect.gen(function* () {
      const providers = yield* Effect.all([GitHub.make, GitLab.make, Bitbucket.make, Azure.make]);
      const legacyCapabilities = Schema.Struct({
        actions: Schema.Array(
          Schema.Literals([
            "merge",
            "ready",
            "draft",
            "close",
            "reopen",
            "update-branch",
            "enable-auto-merge",
            "disable-auto-merge",
            "revert",
            "approve-workflows",
          ]),
        ),
      });
      for (const provider of providers) {
        expect(provider.capabilities.deleteSourceBranch).toBe(true);
        yield* Schema.decodeUnknownEffect(legacyCapabilities)(provider.capabilities);
      }
      const azure = providers[3];
      const viewer = yield* azure.getViewerPermissions({
        cwd: "/w",
        host: "dev.azure.com",
        repository: "web",
        number: 1,
      });
      expect(viewer.deleteSourceBranch).toBe(true);
      yield* Schema.decodeUnknownEffect(legacyCapabilities)(viewer);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(GitHubCli.GitHubPullRequestCli)({}),
          Layer.mock(GitLabCli.GitLabPullRequestCli)({}),
          Layer.mock(BitbucketApi.BitbucketPullRequestApi)({}),
          Layer.mock(AzureCli.AzureDevOpsPullRequestCli)({}),
        ),
      ),
    ),
);
