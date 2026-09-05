import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import * as BitbucketPullRequestApi from "./BitbucketPullRequestApi.ts";
import {
  bitbucketProviderFailure,
  bitbucketViewerPermissions,
  make,
} from "./BitbucketPullRequestProvider.ts";

describe("bitbucketProviderFailure", () => {
  it("treats only an HTTP 401 as unusable credentials", () => {
    const responseError = (status: number) =>
      new BitbucketApi.BitbucketResponseError({
        operation: "request",
        status,
        responseBodyLength: 0,
      });

    expect(bitbucketProviderFailure(responseError(401)).reason).toBe("unauthenticated");
    expect(bitbucketProviderFailure(responseError(403)).reason).toBe("failed");
  });
});

describe("bitbucketViewerPermissions", () => {
  it("offers both actions to credentials with write access", () => {
    expect(bitbucketViewerPermissions({ canWrite: true })).toEqual({
      deleteSourceBranch: true,
      actions: ["merge", "close"],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"],
      // Bitbucket says nothing about who may set a reviewer, and an unreported permission is
      // granted.
      requestReviewers: true,
    });
  });

  it("keeps merge from credentials that can only read the repository", () => {
    expect(bitbucketViewerPermissions({ canWrite: false })).toEqual({
      deleteSourceBranch: true,
      actions: ["close"],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"],
      requestReviewers: true,
    });
  });

  it("treats an author with read access as any other reader, which is all Bitbucket says", () => {
    // The repository permission is the whole of what Bitbucket reports per account; it says
    // nothing about who opened this pull request, and its author may decline it with read access
    // alone — so declining stays offered rather than being taken from them.
    expect(bitbucketViewerPermissions({ canWrite: false }).actions).toEqual(["close"]);
  });
});

it.effect("keeps historical verdict events while removing current review duplicates", () =>
  Effect.gen(function* () {
    const current = "2026-09-05T12:00:00.000Z";
    const older = "2026-09-04T12:00:00.000Z";
    const actor = (login: string) => ({ login, name: null, avatarUrl: null });
    const review = (login: string, reviewState: string) => ({
      id: login,
      kind: "review" as const,
      author: actor(login),
      body: "",
      createdAt: current,
      url: null,
      path: null,
      reviewState,
    });
    const event = (id: string, kind: string, login: string, createdAt: string) => ({
      id,
      kind,
      actor: actor(login),
      createdAt,
      url: null,
      body: kind,
    });
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(BitbucketPullRequestApi.BitbucketPullRequestApi)({
          getPullRequest: () =>
            Effect.succeed({
              number: 7,
              title: "Pull request 7",
              url: "https://bitbucket.org/acme/web/pull-requests/7",
              author: null,
              headBranch: "feature",
              headRepositoryNameWithOwner: null,
              baseBranch: "main",
              state: "open" as const,
              isDraft: false,
              mergeability: "unknown" as const,
              createdAt: older,
              updatedAt: current,
              body: "",
              reviewRequestLogins: [],
              reviewers: [],
              reviewerIds: [],
              reviews: [review("julius", "APPROVED"), review("theo", "CHANGES_REQUESTED")],
            }),
          listComments: () => Effect.succeed({ comments: [], threads: [], truncated: false }),
          listCommits: () => Effect.succeed([]),
          listTimelineEvents: () =>
            Effect.succeed([
              event("approved-current", "approved", "julius", current),
              event("approved-old", "approved", "julius", older),
              event("changes-current", "changes-requested", "theo", current),
              event("changes-old", "changes-requested", "theo", older),
            ]),
        }),
      ),
    );
    const activity = yield* provider.getChangeRequestActivity({
      cwd: "/w",
      repository: "acme/web",
      host: "bitbucket.org",
      number: 7,
    });
    expect(activity.timelineEvents?.map((entry) => entry.id)).toEqual([
      "approved-old",
      "changes-old",
    ]);
  }),
);
