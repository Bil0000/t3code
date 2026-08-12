import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  IssueAction,
  IssueAssigneeCandidateList,
  IssueComment,
  IssueEvent,
  IssueInvolvement,
  IssueLabelCandidateList,
  IssueLinkedPullRequest,
  IssueListState,
} from "@t3tools/contracts";

import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import {
  decodeCreatedIssueJson,
  decodeIssueDetailJson,
  decodeIssueListJson,
  decodeIssueNotesJson,
  decodeLabelEventsJson,
  decodeLinkedMergeRequestsJson,
  decodeProjectLabelsJson,
  decodeProjectMembersJson,
  decodeViewerJson,
  type GitLabIssue,
  type GitLabIssueDetail,
} from "./gitLabIssueJson.ts";
import type { ProviderListCursor } from "./IssueProvider.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class GitLabIssueReadError extends Schema.TaggedErrorClass<GitLabIssueReadError>()(
  "GitLabIssueReadError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `GitLab CLI returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }
}

/** Not a decode failure: glab answered, the account it answered for just has no username. */
export class GitLabIssueViewerUnavailableError extends Schema.TaggedErrorClass<GitLabIssueViewerUnavailableError>()(
  "GitLabIssueViewerUnavailableError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "GitLab CLI returned no username for the authenticated account.";
  }

  override get message(): string {
    return `GitLab CLI failed in getViewerUsername: ${this.detail}`;
  }
}

export type GitLabIssueCliError =
  | GitLabCli.GitLabCliError
  | GitLabIssueReadError
  | GitLabIssueViewerUnavailableError;

/** GitLab's own ceiling on `per_page`, so a larger page has to be walked. */
const MAX_PAGE_SIZE = 100;
/**
 * Pages of the conversation to follow before it is reported as truncated. GitLab caps a page at
 * a hundred, so this is a thousand notes — more than any issue a person is reading holds, and a
 * walk that ends whatever the host has.
 */
const CONVERSATION_PAGES = 10;

export interface GitLabIssueListBatch {
  readonly items: ReadonlyArray<GitLabIssue>;
  readonly truncated: boolean;
  /** Raw GitLab rows consumed to produce this page, including malformed rows. */
  readonly cursorAdvance: number;
}

export interface GitLabIssueActivity {
  readonly comments: ReadonlyArray<IssueComment>;
  readonly events: ReadonlyArray<IssueEvent>;
  readonly truncated: boolean;
}

export class GitLabIssueCli extends Context.Service<
  GitLabIssueCli,
  {
    readonly getViewerUsername: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string, GitLabIssueCliError>;

    readonly listIssues: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly state: IssueListState;
      readonly involvement: IssueInvolvement;
      readonly viewer: string;
      readonly limit: number;
      /** Free text for GitLab's own `search`, which matches title and description. */
      readonly query?: string | undefined;
      /** Where to carry on from in GitLab's stable update-ordered row set. */
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<GitLabIssueListBatch, GitLabIssueCliError>;

    readonly getIssueDetail: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<GitLabIssueDetail, GitLabIssueCliError>;

    /**
     * The merge requests GitLab reports against the issue. Two reads at once, because the ones
     * that close it and the ones that only mention it live behind different endpoints, and
     * neither answers for the other.
     */
    readonly listLinkedMergeRequests: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<IssueLinkedPullRequest>, GitLabIssueCliError>;

    readonly listActivity: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<GitLabIssueActivity, GitLabIssueCliError>;

    readonly createIssue: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly title: string;
      readonly body: string;
      readonly labels: ReadonlyArray<string>;
      readonly assignees: ReadonlyArray<string>;
    }) => Effect.Effect<{ readonly number: number; readonly url: string }, GitLabIssueCliError>;

    readonly updateIssue: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    }) => Effect.Effect<void, GitLabIssueCliError>;

    readonly runIssueAction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly action: IssueAction;
    }) => Effect.Effect<void, GitLabIssueCliError>;

    readonly commentOnIssue: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, GitLabIssueCliError>;

    readonly setLabels: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly labels: ReadonlyArray<string>;
    }) => Effect.Effect<void, GitLabIssueCliError>;

    readonly setAssignees: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      /** GitLab's own numeric user ids, as the candidate list handed them out. */
      readonly assignees: ReadonlyArray<string>;
    }) => Effect.Effect<void, GitLabIssueCliError>;

    readonly listLabelCandidates: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<IssueLabelCandidateList, GitLabIssueCliError>;

    readonly listAssigneeCandidates: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<IssueAssigneeCandidateList, GitLabIssueCliError>;
  }
>()("t3/issue/GitLabIssueCli") {}

/** The REST API addresses a project by its URL-encoded full path. */
function projectPath(repository: string): string {
  return encodeURIComponent(repository.trim());
}

function stateParam(state: IssueListState): string {
  // GitLab calls an open issue `opened`, and spans both states under `all`.
  return state === "open" ? "opened" : state;
}

function involvementParams(input: {
  readonly involvement: IssueInvolvement;
  readonly viewer: string;
}): ReadonlyArray<readonly [string, string]> {
  switch (input.involvement) {
    case "assigned":
      // An array parameter even for one name, which is how GitLab declares it.
      return [["assignee_username[]", input.viewer]];
    case "authored":
      return [["author_username", input.viewer]];
    // GitLab's project issue listing cannot express "mentioned" — its `scope` narrows to the
    // issues the viewer created or is assigned, which is a different question. The unnarrowed
    // page is answered rather than a filter that means something else, and the service narrows.
    case "mentioned":
    case "all":
      return [];
  }
}

function searchParams(search: string | undefined): ReadonlyArray<readonly [string, string]> {
  const trimmed = search?.trim() ?? "";
  return trimmed.length === 0 ? [] : [["search", trimmed]];
}

function query(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

/**
 * The ids GitLab would accept for an assignment. A candidate GitLab did not name is not an id it
 * would take, and sending it would write the assignee set around a number nobody chose.
 */
function assigneeIds(assignees: ReadonlyArray<string>): ReadonlyArray<number> {
  return assignees.flatMap((assignee) => {
    const id = Number(assignee);
    return Number.isSafeInteger(id) && id > 0 ? [id] : [];
  });
}

export const make = Effect.gen(function* () {
  const gitlab = yield* GitLabCli.GitLabCli;

  const api = (input: {
    readonly cwd: string;
    readonly path: string;
    readonly method?: string;
    readonly stdin?: string;
  }) =>
    gitlab.execute({
      cwd: input.cwd,
      args: [
        "api",
        input.path,
        ...(input.method === undefined ? [] : ["--method", input.method]),
        // A raw body from stdin: argv is visible in process listings and is echoed back
        // inside process-runner failure messages. Unlike `gh`, `glab api --input` sends no
        // Content-Type at all, and GitLab answers a bodyless content type with HTTP 415.
        ...(input.stdin === undefined
          ? []
          : ["--input", "-", "--header", "Content-Type: application/json"]),
      ],
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
    });

  const readError =
    (input: { readonly cwd: string; readonly operation: string }) => (cause: unknown) =>
      new GitLabIssueReadError({
        command: "glab",
        cwd: input.cwd,
        operation: input.operation,
        cause,
      });

  /**
   * `per_page` stops at 100, so a larger page is walked one request at a time. The walk is
   * bounded twice over: it stops on a short page or once the extra row that reveals a next
   * page has been read, and it never asks for more pages than the caller's page needs. The
   * second bound is what makes it terminate when every row on a page fails to decode, which
   * leaves nothing collected but does not mean GitLab has run out of rows.
   */
  const listPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly state: IssueListState;
    readonly involvement: IssueInvolvement;
    readonly viewer: string;
    readonly limit: number;
    readonly query?: string | undefined;
    readonly cursor?: ProviderListCursor | undefined;
    readonly page: number;
    readonly collected: ReadonlyArray<GitLabIssue>;
    readonly cursorAdvance: number;
  }): Effect.Effect<GitLabIssueListBatch, GitLabIssueCliError> => {
    // A continuation uses GitLab's offset pagination. Its timestamp filter is inclusive and has
    // no tie-breaker, so a page where many rows share the boundary would otherwise return the
    // same prefix forever. `delivered` is the stable offset the service has already handed over.
    const delivered = input.cursor?.delivered ?? 0;
    const perPage = Math.min(input.limit + 1, MAX_PAGE_SIZE);
    const firstPage = Math.floor(delivered / perPage) + 1;
    const skipOnFirstPage = input.page === firstPage ? delivered % perPage : 0;
    // A page made entirely of malformed rows has no item from which the service can build a
    // continuation. Bound the walk to the raw span this request asked for rather than recursing
    // forever on a host that keeps returning full unusable pages.
    const lastPage = Math.floor((delivered + input.limit) / perPage) + 1;
    return api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/issues?${query([
        ["state", stateParam(input.state)],
        ...involvementParams(input),
        // The listing is read through `glab api` rather than `glab issue list`, so the search is
        // the REST API's own `search` parameter. It matches title and description, and travels
        // URL-encoded like every other value here, so no text in it can become a parameter of
        // its own.
        ...searchParams(input.query),
        ["order_by", "updated_at"],
        ["sort", "desc"],
        ["per_page", String(perPage)],
        ["page", String(input.page)],
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const raw = result.stdout.trim();
        if (raw.length === 0) {
          return Effect.succeed({
            items: input.collected,
            truncated: false,
            cursorAdvance: input.cursorAdvance,
          });
        }
        const decoded = decodeIssueListJson(raw);
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            readError({ cwd: input.cwd, operation: "listIssues" })(decoded.failure),
          );
        }
        const pageItems: GitLabIssue[] = [];
        const pageRawIndexes: number[] = [];
        for (const [index, item] of decoded.success.items.entries()) {
          const rawIndex = decoded.success.rawIndexes[index]!;
          if (rawIndex < skipOnFirstPage) continue;
          pageItems.push(item);
          pageRawIndexes.push(rawIndex);
        }
        const remaining = input.limit - input.collected.length;
        const lastItemRawIndex = pageRawIndexes[remaining - 1];
        if (lastItemRawIndex !== undefined) {
          const consumed = lastItemRawIndex + 1 - skipOnFirstPage;
          return Effect.succeed({
            items: [...input.collected, ...pageItems.slice(0, remaining)],
            truncated:
              lastItemRawIndex + 1 < decoded.success.rawCount ||
              decoded.success.rawCount === perPage,
            cursorAdvance: input.cursorAdvance + consumed,
          });
        }
        const collected = [...input.collected, ...pageItems];
        const consumed = Math.max(0, decoded.success.rawCount - skipOnFirstPage);
        // Counted before decoding, so a skipped malformed row cannot end paging early.
        const exhausted = decoded.success.rawCount < perPage;
        if (exhausted) {
          return Effect.succeed({
            items: collected,
            truncated: false,
            cursorAdvance: input.cursorAdvance + consumed,
          });
        }
        if (input.page >= lastPage) {
          return Effect.succeed({
            items: collected,
            truncated: true,
            cursorAdvance: input.cursorAdvance + consumed,
          });
        }
        return listPage({
          ...input,
          page: input.page + 1,
          collected,
          cursorAdvance: input.cursorAdvance + consumed,
        });
      }),
    );
  };

  const issueDetail = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
  }): Effect.Effect<GitLabIssueDetail, GitLabIssueCliError> =>
    api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/issues/${input.number}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeIssueDetailJson(result.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              readError({ cwd: input.cwd, operation: "getIssueDetail" })(decoded.failure),
            );
      }),
    );

  /**
   * The conversation, a page at a time. GitLab pages by offset and reports no total, so a short
   * page is the only thing that says it is done — and the raw count decides, not the kept one:
   * the notes GitLab wrote itself become events rather than comments, and a whole page of them
   * still means there is more to read.
   */
  const notesPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
    readonly page: number;
    readonly comments: ReadonlyArray<IssueComment>;
    readonly events: ReadonlyArray<IssueEvent>;
  }): Effect.Effect<GitLabIssueActivity, GitLabIssueCliError> =>
    api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/issues/${input.number}/notes?${query([
        ["per_page", String(MAX_PAGE_SIZE)],
        ["page", String(input.page)],
        ["order_by", "created_at"],
        ["sort", "asc"],
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeIssueNotesJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            readError({ cwd: input.cwd, operation: "listActivity" })(decoded.failure),
          );
        }
        const comments = [...input.comments, ...decoded.success.comments];
        const events = [...input.events, ...decoded.success.events];
        if (decoded.success.rawCount < MAX_PAGE_SIZE) {
          return Effect.succeed({ comments, events, truncated: false });
        }
        return input.page >= CONVERSATION_PAGES
          ? Effect.succeed({ comments, events, truncated: true })
          : notesPage({ ...input, page: input.page + 1, comments, events });
      }),
    );

  /** The labellings, walked the same way and stopped by the same bound. */
  const labelEventsPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
    readonly page: number;
    readonly collected: ReadonlyArray<IssueEvent>;
  }): Effect.Effect<ReadonlyArray<IssueEvent>, GitLabIssueCliError> =>
    api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/issues/${
        input.number
      }/resource_label_events?${query([
        ["per_page", String(MAX_PAGE_SIZE)],
        ["page", String(input.page)],
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeLabelEventsJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            readError({ cwd: input.cwd, operation: "listActivity" })(decoded.failure),
          );
        }
        const collected = [...input.collected, ...decoded.success.events];
        return decoded.success.rawCount < MAX_PAGE_SIZE || input.page >= CONVERSATION_PAGES
          ? Effect.succeed(collected)
          : labelEventsPage({ ...input, page: input.page + 1, collected });
      }),
    );

  const linkedMergeRequests = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
    readonly endpoint: "closed_by" | "related_merge_requests";
  }): Effect.Effect<ReadonlyArray<IssueLinkedPullRequest>, GitLabIssueCliError> =>
    api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/issues/${input.number}/${
        input.endpoint
      }?${query([["per_page", String(MAX_PAGE_SIZE)]])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeLinkedMergeRequestsJson(
          result.stdout.trim(),
          input.endpoint === "closed_by",
        );
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              readError({ cwd: input.cwd, operation: "listLinkedMergeRequests" })(decoded.failure),
            );
      }),
    );

  const projectLabels = (input: { readonly cwd: string; readonly repository: string }) =>
    api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/labels?${query([
        ["per_page", String(MAX_PAGE_SIZE)],
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeProjectLabelsJson(result.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              readError({ cwd: input.cwd, operation: "listLabelCandidates" })(decoded.failure),
            );
      }),
    );

  const projectMembers = (input: { readonly cwd: string; readonly repository: string }) =>
    api({
      cwd: input.cwd,
      // `members/all` rather than `members`, so the people a parent group lends the project are
      // offered too — GitLab lets every one of them be assigned an issue.
      path: `projects/${projectPath(input.repository)}/members/all?${query([
        ["per_page", String(MAX_PAGE_SIZE)],
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeProjectMembersJson(result.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              readError({ cwd: input.cwd, operation: "listAssigneeCandidates" })(decoded.failure),
            );
      }),
    );

  /** Every write to an issue is the same PUT, so its body is the only thing that differs. */
  const updateIssue = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
    readonly body: Record<string, unknown>;
  }) =>
    api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/issues/${input.number}`,
      method: "PUT",
      // A JSON body rather than a `--raw-field`: glab coerces a field that reads as a literal
      // `true` or a number, and a title or a description is text either way.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      stdin: JSON.stringify(input.body),
    }).pipe(Effect.asVoid);

  return GitLabIssueCli.of({
    getViewerUsername: (input) =>
      api({ cwd: input.cwd, path: "user" }).pipe(
        Effect.flatMap((result): Effect.Effect<string, GitLabIssueCliError> => {
          const decoded = decodeViewerJson(result.stdout.trim());
          if (!Result.isSuccess(decoded)) {
            return Effect.fail(
              readError({ cwd: input.cwd, operation: "getViewerUsername" })(decoded.failure),
            );
          }
          return decoded.success === null
            ? Effect.fail(
                new GitLabIssueViewerUnavailableError({ command: "glab", cwd: input.cwd }),
              )
            : Effect.succeed(decoded.success);
        }),
      ),

    listIssues: (input) => {
      const perPage = Math.min(input.limit + 1, MAX_PAGE_SIZE);
      const page = Math.floor((input.cursor?.delivered ?? 0) / perPage) + 1;
      return listPage({ ...input, page, collected: [], cursorAdvance: 0 });
    },

    getIssueDetail: issueDetail,

    listLinkedMergeRequests: (input) =>
      Effect.all(
        [
          linkedMergeRequests({ ...input, endpoint: "closed_by" }),
          linkedMergeRequests({ ...input, endpoint: "related_merge_requests" }),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([closing, related]) => {
          // The two endpoints overlap: a merge request that closes the issue also mentions it.
          // The closing answer wins, so the stronger of the two relationships is the one shown.
          const seen = new Set(closing.map((link) => `${link.repository}!${link.number}`));
          return [
            ...closing,
            ...related.filter((link) => !seen.has(`${link.repository}!${link.number}`)),
          ];
        }),
      ),

    listActivity: (input) =>
      Effect.all(
        [
          notesPage({ ...input, page: 1, comments: [], events: [] }),
          labelEventsPage({ ...input, page: 1, collected: [] }),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([notes, labelEvents]) => ({
          comments: notes.comments,
          // Two reads, so the merged history is ordered here rather than left interleaved by
          // whichever of them answered first.
          events: [...notes.events, ...labelEvents].sort((left, right) =>
            left.createdAt === right.createdAt ? 0 : left.createdAt < right.createdAt ? -1 : 1,
          ),
          truncated: notes.truncated,
        })),
      ),

    createIssue: (input) =>
      api({
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}/issues`,
        method: "POST",
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        stdin: JSON.stringify({
          title: input.title,
          description: input.body,
          labels: [...input.labels],
          assignee_ids: assigneeIds(input.assignees),
        }),
      }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodeCreatedIssueJson(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(readError({ cwd: input.cwd, operation: "createIssue" })(decoded.failure));
        }),
      ),

    updateIssue: (input) =>
      updateIssue({
        ...input,
        body: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { description: input.body }),
        },
      }),

    // The same PUT the edit uses: `glab issue close` would do it too, but a state change is one
    // field of the issue, and one path through GitLab is one thing to get right.
    runIssueAction: (input) =>
      updateIssue({
        ...input,
        body: { state_event: input.action === "close" ? "close" : "reopen" },
      }),

    commentOnIssue: (input) =>
      api({
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}/issues/${input.number}/notes`,
        method: "POST",
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        stdin: JSON.stringify({ body: input.body }),
      }).pipe(Effect.asVoid),

    setLabels: (input) =>
      updateIssue({
        ...input,
        // An array, which no label name can break; GitLab documents the empty string, and only
        // the empty string, as the way to take every label off an issue.
        body: { labels: input.labels.length === 0 ? "" : [...input.labels] },
      }),

    setAssignees: (input) =>
      // The whole set rather than a change to it, which is what GitLab writes here anyway: an
      // empty list unassigns everybody.
      updateIssue({ ...input, body: { assignee_ids: assigneeIds(input.assignees) } }),

    listLabelCandidates: (input) =>
      Effect.all([issueDetail(input), projectLabels(input)], { concurrency: 2 }).pipe(
        Effect.map(([issue, labels]) => {
          const applied = new Set(issue.labels.map((label) => label.name));
          return {
            candidates: labels.labels.map((label) => ({
              ...label,
              isApplied: applied.has(label.name),
            })),
            truncated: labels.rawCount >= MAX_PAGE_SIZE,
          };
        }),
      ),

    listAssigneeCandidates: (input) =>
      Effect.all([issueDetail(input), projectMembers(input)], { concurrency: 2 }).pipe(
        Effect.map(([issue, members]) => {
          // Matched by handle: the issue names its assignees, and only the member list carries
          // the numeric id an assignment is written with.
          const assigned = new Set(issue.assignees.map((assignee) => assignee.login));
          return {
            candidates: members.members.map((member) => ({
              ...member,
              isAssigned: assigned.has(member.login),
            })),
            truncated: members.rawCount >= MAX_PAGE_SIZE,
          };
        }),
      ),
  });
});

export const layer = Layer.effect(GitLabIssueCli, make);
