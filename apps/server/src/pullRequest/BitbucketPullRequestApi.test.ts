import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import * as BitbucketPullRequestApi from "./BitbucketPullRequestApi.ts";

const mockedRequest = vi.fn<BitbucketApi.BitbucketApi["Service"]["request"]>();

const layer = it.layer(
  BitbucketPullRequestApi.layer.pipe(
    Layer.provide(
      Layer.mock(BitbucketApi.BitbucketApi)({
        request: mockedRequest,
      }),
    ),
  ),
);

/** The shape `request` answers with: a body plus whether it had to be cut short. */
function response(body: string) {
  return { body, truncated: false };
}

function page(count: number, firstNumber: number, next?: string): string {
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  return JSON.stringify({
    pagelen: 50,
    size: count,
    values: Array.from({ length: count }, (_, index) => ({
      id: firstNumber + index,
      title: `Pull request ${firstNumber + index}`,
      state: "OPEN",
      created_on: "2026-06-16T05:04:32+00:00",
      updated_on: "2026-06-16T05:04:33+00:00",
      source: { branch: { name: "feat/page" } },
      destination: { branch: { name: "master" } },
      links: { html: { href: `https://bitbucket.org/acme/web/pull-requests/${firstNumber}` } },
    })),
    ...(next === undefined ? {} : { next }),
  });
}

/** The request the nth call made. */
function callAt(index: number) {
  const call = mockedRequest.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

afterEach(() => {
  mockedRequest.mockReset();
});

layer("BitbucketPullRequestApi.layer", (it) => {
  it.effect("asks for reviewers, newest first, at Bitbucket's page ceiling", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(3, 1))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const batch = yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 50,
      });

      assert.strictEqual(batch.items.length, 3);
      assert.isFalse(batch.truncated);
      const url = callAt(0).url;
      expect(url).toContain("/repositories/acme/web/pullrequests");
      expect(url).toContain("state=OPEN");
      // Over 50 Bitbucket answers with an empty page and no error, so it is never exceeded.
      expect(url).toContain("pagelen=50");
      expect(url).toContain("sort=-updated_on");
      expect(url).toContain("fields=%2Bvalues.reviewers");
    }),
  );

  it.effect("follows the cursor Bitbucket sends rather than counting offsets", () =>
    Effect.gen(function* () {
      const next = "https://api.bitbucket.org/2.0/repositories/acme/web/pullrequests?page=2";
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response(page(50, 1, next))))
        .mockReturnValueOnce(Effect.succeed(response(page(50, 51))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const batch = yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 100,
      });

      assert.strictEqual(batch.items.length, 100);
      assert.isFalse(batch.truncated);
      assert.strictEqual(callAt(1).url, next);
    }),
  );

  it.effect("stops at the caller's page and says more remain", () =>
    Effect.gen(function* () {
      const next = "https://api.bitbucket.org/2.0/repositories/acme/web/pullrequests?page=2";
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(50, 1, next))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const batch = yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 50,
      });

      assert.strictEqual(batch.items.length, 50);
      assert.isTrue(batch.truncated);
      assert.strictEqual(mockedRequest.mock.calls.length, 1);
    }),
  );

  it.effect("asks for declined pull requests on the closed tab", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.listPullRequests({ repository: "acme/web", state: "closed", limit: 50 });

      expect(callAt(0).url).toContain("state=DECLINED");
    }),
  );

  it.effect("refuses a repository that is not workspace and slug", () =>
    Effect.gen(function* () {
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const error = yield* Effect.flip(
        api.listPullRequests({ repository: "acme/team/web", state: "open", limit: 50 }),
      );

      assert.strictEqual(error._tag, "BitbucketRepositoryUnsupportedError");
      assert.strictEqual(mockedRequest.mock.calls.length, 0);
    }),
  );

  it.effect("returns the diff verbatim, because Bitbucket already sends a patch", () =>
    Effect.gen(function* () {
      const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(patch)));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const diff = yield* api.getPullRequestDiff({ repository: "acme/web", number: 7 });

      assert.strictEqual(diff.patch, patch);
      assert.isFalse(diff.truncated);
      expect(callAt(0)).toMatchObject({
        url: "/repositories/acme/web/pullrequests/7/diff",
        // A diff of any size would otherwise be read into memory whole.
        maxBytes: 8 * 1024 * 1024,
      });
    }),
  );

  it.effect("reads an empty conflict list as mergeable", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const mergeability = yield* api.getMergeability({ repository: "acme/web", number: 7 });

      assert.strictEqual(mergeability, "mergeable");
      expect(callAt(0).url).toBe("/repositories/acme/web/pullrequests/7/conflicts");
    }),
  );

  it.effect("merges with Bitbucket's own name for the strategy", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.runAction({
        repository: "acme/web",
        number: 7,
        action: "merge",
        mergeMethod: "rebase",
      });

      expect(callAt(0)).toMatchObject({
        method: "POST",
        url: "/repositories/acme/web/pullrequests/7/merge",
        body: '{"merge_strategy":"rebase_fast_forward"}',
      });
    }),
  );

  it.effect("closes a pull request by declining it", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.runAction({ repository: "acme/web", number: 7, action: "close" });

      expect(callAt(0)).toMatchObject({
        method: "POST",
        url: "/repositories/acme/web/pullrequests/7/decline",
      });
    }),
  );

  it.effect("posts a comment as a JSON document, so the body stays text", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.comment({ repository: "acme/web", number: 7, body: "true" });

      expect(callAt(0)).toMatchObject({
        method: "POST",
        url: "/repositories/acme/web/pullrequests/7/comments",
        body: '{"content":{"raw":"true"}}',
      });
    }),
  );

  it.effect("fails the read when Bitbucket answers with something unreadable", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        Effect.succeed(response(JSON.stringify({ error: "nope" }))),
      );
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const error = yield* Effect.flip(api.getPullRequest({ repository: "acme/web", number: 7 }));

      assert.strictEqual(error._tag, "BitbucketPullRequestReadError");
    }),
  );

  it.effect("fails when the credentials belong to no named account", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(JSON.stringify({}))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const error = yield* Effect.flip(api.getViewer());

      assert.strictEqual(error._tag, "BitbucketViewerUnavailableError");
    }),
  );
});
