import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { IssueCapabilities, IssueViewerPermissions } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as ForgejoCli from "@t3tools/source-control-forgejo/server/ForgejoCli";
import {
  ForgejoComment,
  ForgejoLabel,
  ForgejoUser,
  forgejoActor,
} from "@t3tools/source-control-forgejo/server/forgejoPullRequestJson";
import {
  IssueProviderError,
  type IssueAdapter,
  type ProviderRepositoryRef,
} from "./IssueProvider.ts";
import {
  ForgejoIssue,
  ForgejoIssueRepository,
  ForgejoIssueTimeline,
  forgejoIssue,
  forgejoIssueComment,
  forgejoIssueEvent,
} from "./ForgejoIssueJson.ts";

const CAPABILITIES: IssueCapabilities = {
  sorts: ["created", "updated"],
  referenceStyle: "hash",
  closesViaPullRequest: true,
  comment: true,
  actions: ["close", "reopen"],
  closeReasons: [],
  create: true,
  issueTemplates: false,
  edit: true,
  editComment: true,
  labels: true,
  assignees: true,
  listLabelCandidates: true,
  listAssigneeCandidates: true,
  search: true,
  linkedPullRequests: false,
  timelineEvents: true,
};
const repoPath = (input: ProviderRepositoryRef) =>
  `repos/${input.repository.split("/").map(encodeURIComponent).join("/")}`;
const issuePath = (input: ProviderRepositoryRef & { readonly number: number }) =>
  `${repoPath(input)}/issues/${input.number}`;
const isForgejoCliError = Schema.is(ForgejoCli.ForgejoCliError);

export const make = Effect.gen(function* () {
  const cli = yield* ForgejoCli.ForgejoCli;
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new IssueProviderError({
      provider: "forgejo",
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const fail = (operation: string) => (error: ForgejoCli.ForgejoCliError) =>
    new IssueProviderError({
      provider: "forgejo",
      operation,
      reason:
        error.reason === "missing-cli"
          ? "missing-tool"
          : error.reason === "authentication"
            ? "unauthenticated"
            : error.reason === "rate-limit"
              ? "rate-limited"
              : "failed",
      detail: error.detail,
      cause: error,
    });
  const request = (input: ForgejoCli.ForgejoApiInput) =>
    cli.api(input).pipe(Effect.mapError(fail(input.path)));
  const read = Effect.fn("ForgejoIssueProvider.read")(function* <A>(
    input: ForgejoCli.ForgejoApiInput,
    schema: Schema.Codec<A, unknown, never, never>,
  ) {
    const response = yield* request(input);
    if (response.stdoutTruncated)
      return yield* failure(input.path, "Forgejo response exceeded the output limit.");
    const decoded = decodeJsonResult(schema)(response.stdout);
    if (Result.isFailure(decoded))
      return yield* failure(input.path, "Forgejo returned an invalid response.", decoded.failure);
    return decoded.success;
  });
  const readPage = Effect.fn("ForgejoIssueProvider.readPage")(function* <A>(
    input: ForgejoCli.ForgejoApiInput,
    schema: Schema.Codec<A, unknown, never, never>,
    page: number,
  ) {
    const response = yield* request({
      ...input,
      path: `${input.path}${input.path.includes("?") ? "&" : "?"}limit=50&page=${page}`,
    });
    if (response.stdoutTruncated)
      return yield* failure(input.path, "Forgejo response exceeded the output limit.");
    const decoded = decodeJsonResult(Schema.NullOr(Schema.Array(schema)))(response.stdout);
    if (Result.isFailure(decoded))
      return yield* failure(input.path, "Forgejo returned an invalid response.", decoded.failure);
    const rows = decoded.success ?? [];
    const link = /^link:\s*(.*)$/im.exec(response.stderr)?.[1];
    return { rows, more: rows.length > 0 && (link === undefined || /rel="?next"?/i.test(link)) };
  });
  const readPages = Effect.fn("ForgejoIssueProvider.readPages")(function* <A>(
    input: ForgejoCli.ForgejoApiInput,
    schema: Schema.Codec<A, unknown, never, never>,
    maxPages: number,
  ) {
    const rows: A[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const response = yield* readPage(input, schema, page);
      rows.push(...response.rows);
      if (!response.more) return { rows, truncated: false };
    }
    return { rows, truncated: true };
  });
  const write = (input: ForgejoCli.ForgejoApiInput) => request(input).pipe(Effect.asVoid);
  const getViewer = (input: { readonly cwd: string; readonly host: string }) =>
    read({ ...input, path: "user" }, ForgejoUser).pipe(Effect.map((user) => user.login));
  const getIssue = Effect.fn("ForgejoIssueProvider.getIssue")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    const issue = yield* read({ ...input, path: issuePath(input) }, ForgejoIssue);
    if (issue.pull_request)
      return yield* failure("getIssue", "This reference is a pull request, not an issue.");
    return issue;
  });
  const getRepository = Effect.fn("ForgejoIssueProvider.getRepository")(function* (
    input: ProviderRepositoryRef,
  ) {
    const repository = yield* read({ ...input, path: repoPath(input) }, ForgejoIssueRepository);
    if (repository.has_issues === false)
      return yield* new IssueProviderError({
        provider: "forgejo",
        operation: "getRepository",
        reason: "tracker-disabled",
        detail: "This repository's issue tracker is disabled.",
      });
    return repository;
  });
  const permissions = (
    repository: typeof ForgejoIssueRepository.Type,
    issue: typeof ForgejoIssue.Type,
    viewer: string,
  ): IssueViewerPermissions => {
    const active = !repository.archived;
    const canWrite = repository.permissions?.push ?? false;
    const canEdit = canWrite || issue.user?.login === viewer;
    return {
      actions: active && canEdit ? CAPABILITIES.actions : [],
      comment: active && (!issue.is_locked || canWrite),
      edit: active && canEdit,
      labels: active && canWrite,
      assignees: active && canWrite,
      create: active,
    };
  };
  const commentsPage = Effect.fn("ForgejoIssueProvider.commentsPage")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
    page: number,
  ) {
    const response = yield* readPage(
      { ...input, path: `${issuePath(input)}/comments` },
      ForgejoComment,
      page,
    );
    return {
      comments: response.rows.map(forgejoIssueComment),
      nextCursor: response.more ? String(page + 1) : null,
    };
  });
  const listLabels = Effect.fn("ForgejoIssueProvider.listLabels")(function* (
    input: ProviderRepositoryRef,
  ) {
    const target = yield* cli.resolveRepository(input).pipe(Effect.mapError(fail("listLabels")));
    const owner = target.repository.split("/")[0]!;
    const [repository, organization] = yield* Effect.all(
      [
        readPages({ ...input, path: `${repoPath(input)}/labels` }, ForgejoLabel, 20),
        readPages(
          { ...input, path: `orgs/${encodeURIComponent(owner)}/labels` },
          ForgejoLabel,
          20,
        ).pipe(
          Effect.catch((error) =>
            isForgejoCliError(error.cause) && error.cause.reason === "not-found"
              ? Effect.succeed({ rows: [], truncated: false })
              : Effect.fail(error),
          ),
        ),
      ],
      { concurrency: 2 },
    );
    return {
      rows: [
        ...new Map(
          [...organization.rows, ...repository.rows].map((label) => [label.name, label]),
        ).values(),
      ],
      truncated: repository.truncated || organization.truncated,
    };
  });
  const labelIds = Effect.fn("ForgejoIssueProvider.labelIds")(function* (
    input: ProviderRepositoryRef,
    names: ReadonlyArray<string>,
  ) {
    if (names.length === 0) return [];
    const labels = yield* listLabels(input);
    const ids: number[] = [];
    for (const name of names) {
      const label = labels.rows.find((candidate) => candidate.name === name);
      if (!label) return yield* failure("setLabels", `Forgejo label was not found: ${name}`);
      ids.push(label.id);
    }
    return ids;
  });
  const provider: IssueAdapter = {
    kind: "forgejo",
    capabilities: CAPABILITIES,
    getViewer,
    listIssues: Effect.fn("ForgejoIssueProvider.listIssues")(function* (input) {
      yield* getRepository(input);
      const query = new URLSearchParams({ type: "issues", state: input.state });
      query.set(
        "sort",
        input.sort === "created"
          ? input.order === "asc"
            ? "oldest"
            : "latest"
          : input.order === "asc"
            ? "leastupdate"
            : "recentupdate",
      );
      if (input.query) query.set("q", input.query);
      const involvement =
        input.involvement === "assigned"
          ? "assigned_by"
          : input.involvement === "authored"
            ? "created_by"
            : input.involvement === "mentioned"
              ? "mentioned_by"
              : null;
      if (involvement) query.set(involvement, input.viewer);
      const response = yield* readPages(
        { ...input, path: `${repoPath(input)}/issues?${query}` },
        ForgejoIssue,
        20,
      );
      const rows = response.rows.filter((issue) => !issue.pull_request).map(forgejoIssue);
      const sort = input.sort === "created" ? "createdAt" : "updatedAt";
      rows.sort(
        (a, b) =>
          (input.order === "asc" ? 1 : -1) *
          (a[sort].localeCompare(b[sort]) || a.number - b.number),
      );
      return {
        items: rows.slice(0, input.limit),
        truncated: response.truncated || rows.length > input.limit,
        continues: false,
      };
    }),
    getIssueSummary: (input) => getIssue(input).pipe(Effect.map(forgejoIssue)),
    getIssue: Effect.fn("ForgejoIssueProvider.detail")(function* (input) {
      const [issue, repository, viewer] = yield* Effect.all(
        [getIssue(input), getRepository(input), getViewer(input)],
        { concurrency: 3 },
      );
      return {
        ...forgejoIssue(issue),
        body: issue.body ?? "",
        viewer,
        ...(repository.html_url ? { repositoryUrl: repository.html_url } : {}),
        linkedPullRequests: [],
        viewerPermissions: permissions(repository, issue, viewer),
      };
    }),
    getIssueActivity: Effect.fn("ForgejoIssueProvider.getIssueActivity")(function* (input) {
      const [issue, comments, timeline] = yield* Effect.all(
        [
          getIssue(input),
          commentsPage(input, 1),
          readPages(
            { ...input, path: `${issuePath(input)}/timeline` },
            Schema.NullOr(ForgejoIssueTimeline),
            10,
          ),
        ],
        { concurrency: 3 },
      );
      return {
        comments: comments.comments,
        commentCount: issue.comments ?? comments.comments.length,
        commentsTruncated: comments.nextCursor !== null,
        nextCommentsCursor: comments.nextCursor,
        events: timeline.rows.flatMap((row) => {
          const event = row === null ? null : forgejoIssueEvent(row);
          return event ? [event] : [];
        }),
      };
    }),
    getIssueComments: (input) =>
      /^[1-9]\d{0,5}$/.test(input.cursor)
        ? commentsPage(input, Number(input.cursor))
        : Effect.fail(failure("getIssueComments", "Invalid Forgejo comments cursor.")),
    getViewerPermissions: Effect.fn("ForgejoIssueProvider.getViewerPermissions")(function* (input) {
      const [issue, repository, viewer] = yield* Effect.all(
        [getIssue(input), getRepository(input), getViewer(input)],
        { concurrency: 3 },
      );
      return permissions(repository, issue, viewer);
    }),
    runAction: (input) =>
      input.action === "close" || input.action === "reopen"
        ? write({
            ...input,
            path: issuePath(input),
            method: "PATCH",
            body: { state: input.action === "close" ? "closed" : "open" },
          })
        : Effect.fail(failure("runAction", "Forgejo does not support this issue action.")),
    comment: (input) =>
      write({
        ...input,
        path: `${issuePath(input)}/comments`,
        method: "POST",
        body: { body: input.body },
      }),
    updateComment: Effect.fn("ForgejoIssueProvider.updateComment")(function* (input) {
      if (!/^[1-9]\d*$/.test(input.commentId))
        return yield* failure("updateComment", "Invalid Forgejo comment id.");
      const path = `${repoPath(input)}/issues/comments/${input.commentId}`;
      const comment = yield* read(
        { ...input, path },
        Schema.Struct({ ...ForgejoComment.fields, issue_url: Schema.String }),
      );
      if (!URL.canParse(comment.issue_url))
        return yield* failure("updateComment", "Forgejo returned an invalid comment issue URL.");
      const url = new URL(comment.issue_url);
      const target = yield* cli
        .resolveRepository(input)
        .pipe(Effect.mapError(fail("updateComment")));
      const expectedPath = new URL(
        `${target.baseUrl}/api/v1/${issuePath({ ...input, repository: target.repository })}`,
      ).pathname;
      if (url.host.toLowerCase() !== input.host.toLowerCase() || url.pathname !== expectedPath)
        return yield* failure("updateComment", "This comment belongs to another issue.");
      yield* write({ ...input, path, method: "PATCH", body: { body: input.body } });
    }),
    create: Effect.fn("ForgejoIssueProvider.create")(function* (input) {
      const labels = yield* labelIds(input, input.labels);
      const issue = yield* read(
        {
          ...input,
          path: `${repoPath(input)}/issues`,
          method: "POST",
          body: { title: input.title, body: input.body, labels, assignees: input.assignees },
        },
        ForgejoIssue,
      );
      return { number: issue.number, url: issue.html_url };
    }),
    update: (input) =>
      write({
        ...input,
        path: issuePath(input),
        method: "PATCH",
        body: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
        },
      }),
    setLabels: Effect.fn("ForgejoIssueProvider.setLabels")(function* (input) {
      const labels = yield* labelIds(input, input.labels);
      yield* write({
        ...input,
        path: `${issuePath(input)}/labels`,
        method: "PUT",
        body: { labels },
      });
    }),
    setAssignees: (input) =>
      write({
        ...input,
        path: issuePath(input),
        method: "PATCH",
        body: { assignees: input.assignees },
      }),
    listLabelCandidates: Effect.fn("ForgejoIssueProvider.listLabelCandidates")(function* (input) {
      const [labels, issue] = yield* Effect.all([listLabels(input), getIssue(input)], {
        concurrency: 2,
      });
      return {
        candidates: labels.rows.map((label) => ({
          name: label.name,
          color: label.color ?? null,
          description: label.description ?? null,
          isApplied: issue.labels?.some((applied) => applied.id === label.id) ?? false,
        })),
        truncated: labels.truncated,
      };
    }),
    listAssigneeCandidates: Effect.fn("ForgejoIssueProvider.listAssigneeCandidates")(
      function* (input) {
        const [users, issue] = yield* Effect.all(
          [
            readPages({ ...input, path: `${repoPath(input)}/assignees` }, ForgejoUser, 10),
            getIssue(input),
          ],
          { concurrency: 2 },
        );
        return {
          candidates: users.rows.flatMap((user) => {
            const actor = forgejoActor(user);
            return actor
              ? [
                  {
                    ...actor,
                    id: user.login,
                    isAssigned:
                      issue.assignees?.some((assignee) => assignee.login === user.login) ?? false,
                  },
                ]
              : [];
          }),
          truncated: users.truncated,
        };
      },
    ),
  };
  return provider;
});
