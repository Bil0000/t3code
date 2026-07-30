import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestState,
} from "@t3tools/contracts";

import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import {
  decodeCommentsJson,
  decodeCommitsJson,
  decodeConflictsJson,
  decodeDiffstatJson,
  decodePullRequestJson,
  decodePullRequestPageJson,
  decodeStatusesJson,
  decodeViewerJson,
  type BitbucketDiffStat,
  type BitbucketPullRequest,
} from "./bitbucketPullRequestJson.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class BitbucketPullRequestReadError extends Schema.TaggedErrorClass<BitbucketPullRequestReadError>()(
  "BitbucketPullRequestReadError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Bitbucket returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `Bitbucket failed in ${this.operation}: ${this.detail}`;
  }
}

/** Not a decode failure: Bitbucket answered, the account it answered for just has no handle. */
export class BitbucketViewerUnavailableError extends Schema.TaggedErrorClass<BitbucketViewerUnavailableError>()(
  "BitbucketViewerUnavailableError",
  {},
) {
  get detail(): string {
    return "Bitbucket returned no account name for the configured credentials.";
  }

  override get message(): string {
    return `Bitbucket failed in getViewer: ${this.detail}`;
  }
}

/** A repository that is not `workspace/slug`, which is the only form Bitbucket addresses. */
export class BitbucketRepositoryUnsupportedError extends Schema.TaggedErrorClass<BitbucketRepositoryUnsupportedError>()(
  "BitbucketRepositoryUnsupportedError",
  {
    repository: Schema.String,
  },
) {
  get detail(): string {
    return "A Bitbucket repository is addressed as workspace/repository.";
  }

  override get message(): string {
    return `Bitbucket failed in resolveRepository: ${this.detail}`;
  }
}

export type BitbucketPullRequestApiError =
  | BitbucketApi.BitbucketApiError
  | BitbucketPullRequestReadError
  | BitbucketViewerUnavailableError
  | BitbucketRepositoryUnsupportedError;

/**
 * Bitbucket's own ceiling. Asking for more does not fail — it answers with an empty page and no
 * error at all, so this is a number to respect rather than to push against.
 */
const MAX_PAGE_SIZE = 50;
/** Pages to walk before a listing is reported as truncated. */
const MAX_LIST_PAGES = 10;
/** Conversation, commits and checks are read one page deep; the rest stays on Bitbucket. */
const CONVERSATION_PAGE_SIZE = 50;

export interface BitbucketPullRequestBatch {
  readonly items: ReadonlyArray<BitbucketPullRequest>;
  readonly truncated: boolean;
}

export class BitbucketPullRequestApi extends Context.Service<
  BitbucketPullRequestApi,
  {
    /** A function rather than a value, so the request is built per call and not at layer time. */
    readonly getViewer: () => Effect.Effect<string, BitbucketPullRequestApiError>;

    readonly listPullRequests: (input: {
      readonly repository: string;
      readonly state: PullRequestState;
      readonly limit: number;
    }) => Effect.Effect<BitbucketPullRequestBatch, BitbucketPullRequestApiError>;

    readonly getPullRequest: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<BitbucketPullRequest, BitbucketPullRequestApiError>;

    readonly getPullRequestDiff: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<string, BitbucketPullRequestApiError>;

    readonly getDiffStat: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<BitbucketDiffStat, BitbucketPullRequestApiError>;

    readonly getMergeability: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestMergeability, BitbucketPullRequestApiError>;

    readonly listComments: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      { readonly comments: ReadonlyArray<PullRequestComment>; readonly truncated: boolean },
      BitbucketPullRequestApiError
    >;

    readonly listCommits: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCommit>, BitbucketPullRequestApiError>;

    readonly listChecks: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCheck>, BitbucketPullRequestApiError>;

    readonly runAction: (input: {
      readonly repository: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;

    readonly comment: (input: {
      readonly repository: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;
  }
>()("t3/pullRequest/BitbucketPullRequestApi") {}

/** `workspace/slug`; Bitbucket has no deeper nesting to address. */
function repositoryPath(
  repository: string,
): Result.Result<string, BitbucketRepositoryUnsupportedError> {
  const segments = repository
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const [workspace, slug] = segments;
  if (segments.length !== 2 || workspace === undefined || slug === undefined) {
    return Result.fail(new BitbucketRepositoryUnsupportedError({ repository }));
  }
  return Result.succeed(
    `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`,
  );
}

function stateParam(state: PullRequestState): string {
  switch (state) {
    case "open":
      return "OPEN";
    case "merged":
      return "MERGED";
    case "closed":
      // Bitbucket separates a declined pull request from one superseded by another, and repeating
      // the parameter does not union them, so the Closed tab shows the declined ones.
      return "DECLINED";
  }
}

/** Bitbucket's merge strategies, named differently from the three the contract carries. */
function mergeStrategy(method: PullRequestMergeMethod | undefined): string {
  switch (method) {
    case "squash":
      return "squash";
    case "rebase":
      // The linear history GitHub calls "rebase and merge".
      return "rebase_fast_forward";
    default:
      return "merge_commit";
  }
}

export const make = Effect.gen(function* () {
  const bitbucket = yield* BitbucketApi.BitbucketApi;

  const withRepository = <A>(
    repository: string,
    use: (path: string) => Effect.Effect<A, BitbucketPullRequestApiError>,
  ): Effect.Effect<A, BitbucketPullRequestApiError> => {
    const path = repositoryPath(repository);
    return Result.isSuccess(path) ? use(path.success) : Effect.fail(path.failure);
  };

  /**
   * Bitbucket pages with a cursor rather than an offset, so the walk follows the `next` URL it
   * sends. It stops once the caller's page is filled, when Bitbucket reports no next page, or at
   * the page cap — and anything but running out of pages means there is more to be had.
   */
  const listPage = (input: {
    readonly url: string;
    readonly limit: number;
    readonly page: number;
    readonly collected: ReadonlyArray<BitbucketPullRequest>;
  }): Effect.Effect<BitbucketPullRequestBatch, BitbucketPullRequestApiError> =>
    bitbucket.request({ method: "GET", url: input.url }).pipe(
      Effect.flatMap((body) => {
        const decoded = decodePullRequestPageJson(body);
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new BitbucketPullRequestReadError({
              operation: "listPullRequests",
              cause: decoded.failure,
            }),
          );
        }
        const collected = [...input.collected, ...decoded.success.items];
        const next = decoded.success.next;
        if (next === null || collected.length >= input.limit || input.page >= MAX_LIST_PAGES) {
          return Effect.succeed({
            items: collected.slice(0, input.limit),
            truncated: next !== null,
          });
        }
        return listPage({ ...input, url: next, page: input.page + 1, collected });
      }),
    );

  const readPage = <A>(input: {
    readonly operation: string;
    readonly url: string;
    readonly decode: (body: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, BitbucketPullRequestApiError> =>
    bitbucket.request({ method: "GET", url: input.url }).pipe(
      Effect.flatMap((body) => {
        const decoded = input.decode(body);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new BitbucketPullRequestReadError({
                operation: input.operation,
                cause: decoded.failure,
              }),
            );
      }),
    );

  return BitbucketPullRequestApi.of({
    getViewer: () =>
      bitbucket.request({ method: "GET", url: "/user" }).pipe(
        Effect.flatMap((body): Effect.Effect<string, BitbucketPullRequestApiError> => {
          const decoded = decodeViewerJson(body);
          if (!Result.isSuccess(decoded)) {
            return Effect.fail(
              new BitbucketPullRequestReadError({ operation: "getViewer", cause: decoded.failure }),
            );
          }
          return decoded.success === null
            ? Effect.fail(new BitbucketViewerUnavailableError())
            : Effect.succeed(decoded.success);
        }),
      ),

    listPullRequests: (input) =>
      withRepository(input.repository, (path) =>
        listPage({
          // Reviewers are not on a listing by default, and `viewerReviewRequested` needs them.
          url: `${path}/pullrequests?state=${stateParam(input.state)}&pagelen=${MAX_PAGE_SIZE}&sort=-updated_on&fields=%2Bvalues.reviewers`,
          limit: input.limit,
          page: 1,
          collected: [],
        }),
      ),

    getPullRequest: (input) =>
      withRepository(input.repository, (path) =>
        readPage({
          operation: "getPullRequest",
          url: `${path}/pullrequests/${input.number}`,
          decode: decodePullRequestJson,
        }),
      ),

    getPullRequestDiff: (input) =>
      withRepository(input.repository, (path) =>
        // Already a unified patch, so it needs no decoding at all.
        bitbucket.request({ method: "GET", url: `${path}/pullrequests/${input.number}/diff` }),
      ),

    getDiffStat: (input) =>
      withRepository(input.repository, (path) =>
        readPage({
          operation: "getDiffStat",
          url: `${path}/pullrequests/${input.number}/diffstat?pagelen=${MAX_PAGE_SIZE}`,
          decode: decodeDiffstatJson,
        }),
      ),

    getMergeability: (input) =>
      withRepository(input.repository, (path) =>
        readPage({
          operation: "getMergeability",
          url: `${path}/pullrequests/${input.number}/conflicts`,
          decode: decodeConflictsJson,
        }),
      ),

    listComments: (input) =>
      withRepository(input.repository, (path) =>
        readPage({
          operation: "listComments",
          url: `${path}/pullrequests/${input.number}/comments?pagelen=${CONVERSATION_PAGE_SIZE}`,
          decode: decodeCommentsJson,
        }).pipe(
          // Deleted and unposted comments are dropped, so the cursor is the only honest signal
          // that more remain.
          Effect.map((page) => ({ comments: page.comments, truncated: page.next !== null })),
        ),
      ),

    listCommits: (input) =>
      withRepository(input.repository, (path) =>
        readPage({
          operation: "listCommits",
          url: `${path}/pullrequests/${input.number}/commits?pagelen=${CONVERSATION_PAGE_SIZE}`,
          decode: decodeCommitsJson,
        }),
      ),

    listChecks: (input) =>
      withRepository(input.repository, (path) =>
        readPage({
          operation: "listChecks",
          url: `${path}/pullrequests/${input.number}/statuses?pagelen=${CONVERSATION_PAGE_SIZE}`,
          decode: decodeStatusesJson,
        }),
      ),

    runAction: (input) =>
      withRepository(input.repository, (path) => {
        const pullRequest = `${path}/pullrequests/${input.number}`;
        // Only merge and close reach here: the provider declares the others unsupported, so the
        // surface never offers them.
        if (input.action === "merge") {
          return bitbucket
            .request({
              method: "POST",
              url: `${pullRequest}/merge`,
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              body: JSON.stringify({ merge_strategy: mergeStrategy(input.mergeMethod) }),
            })
            .pipe(Effect.asVoid);
        }
        return bitbucket
          .request({ method: "POST", url: `${pullRequest}/decline` })
          .pipe(Effect.asVoid);
      }),

    comment: (input) =>
      withRepository(input.repository, (path) =>
        bitbucket
          .request({
            method: "POST",
            url: `${path}/pullrequests/${input.number}/comments`,
            // A JSON document rather than a form field, so the body stays text whatever it says.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            body: JSON.stringify({ content: { raw: input.body } }),
          })
          .pipe(Effect.asVoid),
      ),
  });
});

export const layer = Layer.effect(BitbucketPullRequestApi, make);
