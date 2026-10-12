import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  IssueCapabilities,
  IssueLinkedPullRequest,
  IssueViewerPermissions,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as ForgejoCli from "@t3tools/source-control-forgejo/server/ForgejoCli";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import {
  ForgejoComment,
  ForgejoLabel,
  ForgejoUser,
  ForgejoReaction,
  FORGEJO_REACTIONS,
  forgejoActor,
  forgejoReactions,
} from "@t3tools/source-control-forgejo/server/forgejoPullRequestJson";
import {
  IssueProviderError,
  type IssueAdapter,
  type ProviderRepositoryRef,
  type ProviderIssue,
} from "./IssueProvider.ts";
import {
  ForgejoIssue,
  ForgejoIssueRepository,
  ForgejoIssueTimeline,
  ForgejoIssueCommentsCursor,
  ForgejoIssuePageCursor,
  ForgejoIssueLinkedPullRequest,
  ForgejoIssueTemplate,
  forgejoIssue,
  forgejoIssueComment,
  forgejoIssueEvent,
  forgejoIssueTemplate,
} from "./ForgejoIssueJson.ts";
import { decodeIssueTemplateConfigYaml, DEFAULT_ISSUE_TEMPLATE_CONFIG } from "./gitHubIssueJson.ts";

const CAPABILITIES: IssueCapabilities = {
  sorts: ["created", "updated"],
  referenceStyle: "hash",
  closesViaPullRequest: true,
  comment: true,
  actions: ["close", "reopen"],
  closeReasons: [],
  create: true,
  issueTemplates: true,
  edit: true,
  editComment: true,
  labels: true,
  assignees: true,
  listLabelCandidates: true,
  listAssigneeCandidates: true,
  search: true,
  reactions: true,
  commentReactions: true,
  linkedPullRequests: true,
  timelineEvents: true,
};
const repoPath = (input: ProviderRepositoryRef) =>
  `repos/${input.repository.split("/").map(encodeURIComponent).join("/")}`;
const issuePath = (input: ProviderRepositoryRef & { readonly number: number }) =>
  `${repoPath(input)}/issues/${input.number}`;
const isForgejoCliError = Schema.is(ForgejoCli.ForgejoCliError);
const decodeCommentsCursor = Schema.decodeResult(ForgejoIssueCommentsCursor);
const encodeCommentsCursor = Schema.encodeEffect(ForgejoIssueCommentsCursor);
const encodePagePayload = Schema.encodeEffect(Schema.fromJsonString(ForgejoIssuePageCursor));
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const make = Effect.gen(function* () {
  const cli = yield* ForgejoCli.ForgejoCli;
  const crypto = yield* Crypto.Crypto;
  const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new IssueProviderError({
      provider: "forgejo",
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const cursorKey = yield* crypto
    .randomBytes(32)
    .pipe(
      Effect.mapError((cause) => failure("cursor", "Could not create Forgejo cursor key.", cause)),
    );
  type PullsSnapshot = {
    readonly baseUrl: string;
    readonly refs: ReadonlyArray<readonly [string, number, boolean]>;
    readonly seen: ReadonlyArray<string>;
    readonly complete: boolean;
    readonly page: number | null;
  };
  const snapshots = yield* Cache.makeWith<string, PullsSnapshot, IssueProviderError>(
    () =>
      Effect.fail(
        failure(
          "getIssueLinkedPullRequests",
          "Forgejo linked pull requests cursor expired. Refresh the issue to continue.",
        ),
      ),
    { capacity: 64, timeToLive: (exit) => (Exit.isSuccess(exit) ? "15 minutes" : 0) },
  );
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
      ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
      cause: error,
    });
  const request = Effect.fn("ForgejoIssueProvider.request")(function* (
    input: ForgejoCli.ForgejoApiInput & Pick<ProviderRepositoryRef, "host">,
  ) {
    const key = { provider: "forgejo" as const, host: input.host };
    const lease = yield* limits.check(key).pipe(
      Effect.mapError(
        (error) =>
          new IssueProviderError({
            provider: "forgejo",
            operation: input.path,
            reason: "rate-limited",
            detail: error.detail,
            retryAt: error.retryAt,
            cause: error,
          }),
      ),
    );
    return yield* cli.api(input).pipe(
      Effect.tapError((error) =>
        error.reason === "rate-limit"
          ? limits.recordRateLimit({ ...key, lease, retryAt: error.retryAt })
          : Effect.void,
      ),
      Effect.tap(() => limits.recordSuccess({ ...key, lease })),
      Effect.mapError(fail(input.path)),
    );
  });
  const signature = (
    input: ProviderRepositoryRef & { readonly number: number },
    payload: string,
    credential: string,
  ) =>
    hmac(
      sha256,
      cursorKey,
      JSON.stringify([input.host, input.cwd, input.repository, input.number, credential, payload]),
    );
  const encodePageCursor = Effect.fn("ForgejoIssueProvider.encodePageCursor")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
    value: typeof ForgejoIssuePageCursor.Type,
  ) {
    const encoded = yield* encodePagePayload(value).pipe(
      Effect.mapError((cause) => failure("cursor", "Could not encode Forgejo cursor.", cause)),
    );
    const payload = Buffer.from(encoded).toString("base64url");
    const credential = yield* SourceControlRateLimit.CredentialScope;
    return `${payload}.${Buffer.from(signature(input, payload, credential)).toString("hex")}`;
  });
  const decodePageCursor = Effect.fn("ForgejoIssueProvider.decodePageCursor")(function* (
    input: ProviderRepositoryRef & { readonly number: number; readonly cursor: string },
  ) {
    if (input.cursor.length > 16384 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(input.cursor))
      return null;
    const [payload, signed] = input.cursor.split(".");
    const credential = yield* SourceControlRateLimit.CredentialScope;
    const expected = signature(input, payload!, credential);
    const actual = Buffer.from(signed!, "hex");
    if (expected.reduce((difference, byte, index) => difference | (byte ^ actual[index]!), 0) !== 0)
      return null;
    const decoded = decodeJsonResult(ForgejoIssuePageCursor)(
      Buffer.from(payload!, "base64url").toString("utf8"),
    );
    return Result.isSuccess(decoded) ? decoded.success : null;
  });
  const read = Effect.fn("ForgejoIssueProvider.read")(function* <A>(
    input: ForgejoCli.ForgejoApiInput & Pick<ProviderRepositoryRef, "host">,
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
    input: ForgejoCli.ForgejoApiInput & Pick<ProviderRepositoryRef, "host">,
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
    const last = /<([^>]+)>;\s*rel="?last"?/i.exec(link ?? "")?.[1];
    const lastPage =
      last && URL.canParse(last) ? Number(new URL(last).searchParams.get("page")) : 0;
    const total = /^x-total-count:\s*(\d+)$/im.exec(response.stderr)?.[1];
    return {
      rows,
      more:
        link === undefined
          ? rows.length > 0 || page * 50 < Number(total ?? 0)
          : /rel="?next"?/i.test(link),
      lastPage: Number.isSafeInteger(lastPage) && lastPage > 0 ? lastPage : null,
      totalCount: total === undefined ? null : Number(total),
    };
  });
  const readPages = Effect.fn("ForgejoIssueProvider.readPages")(function* <A>(
    input: ForgejoCli.ForgejoApiInput & Pick<ProviderRepositoryRef, "host">,
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
  const readTimelinePages = Effect.fn("ForgejoIssueProvider.readTimelinePages")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
    start: number,
  ) {
    const rows: (typeof ForgejoIssueTimeline.Type | null)[] = [];
    for (let page = start; page < start + 2; page++) {
      const response = yield* readPage(
        { ...input, path: `${issuePath(input)}/timeline` },
        Schema.NullOr(ForgejoIssueTimeline),
        page,
      );
      rows.push(...response.rows);
      if (response.rows.length === 0) return { rows, truncated: true, nextPage: null };
    }
    return { rows, truncated: true, nextPage: start <= 2147483643 ? start + 2 : null };
  });
  const readTimeline = Effect.fn("ForgejoIssueProvider.readTimeline")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    const path = `${issuePath(input)}/timeline`;
    const response = yield* request({ ...input, path });
    if (response.stdoutTruncated) return yield* readTimelinePages(input, 1);
    const decoded = decodeJsonResult(
      Schema.NullOr(Schema.Array(Schema.NullOr(ForgejoIssueTimeline))),
    )(response.stdout);
    if (Result.isFailure(decoded))
      return yield* failure(path, "Forgejo returned an invalid response.", decoded.failure);
    return { rows: decoded.success ?? [], truncated: false, nextPage: null };
  });
  const write = (input: ForgejoCli.ForgejoApiInput & Pick<ProviderRepositoryRef, "host">) =>
    request(input).pipe(Effect.asVoid);
  const readComplete = Effect.fn("ForgejoIssueProvider.readComplete")(function* <A>(
    input: ForgejoCli.ForgejoApiInput & Pick<ProviderRepositoryRef, "host">,
    schema: Schema.Codec<A, unknown, never, never>,
  ) {
    return (yield* readPages(input, schema, Infinity)).rows;
  });
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
    rows: ReadonlyArray<typeof ForgejoComment.Type>,
    viewer: string,
    cursor?: typeof ForgejoIssueCommentsCursor.Type,
  ) {
    const comments = rows
      .map(forgejoIssueComment)
      .sort(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || Number(a.id) - Number(b.id),
      )
      .filter(
        (comment) =>
          !cursor ||
          Date.parse(comment.createdAt) > Date.parse(cursor[0]) ||
          (Date.parse(comment.createdAt) === Date.parse(cursor[0]) &&
            Number(comment.id) > cursor[1]),
      );
    const page = comments.slice(0, 50);
    const last = page.at(-1);
    return {
      comments: yield* Effect.forEach(
        page,
        (comment) =>
          read(
            { ...input, path: `${repoPath(input)}/issues/comments/${comment.id}/reactions` },
            Schema.NullOr(Schema.Array(ForgejoReaction)),
          ).pipe(
            Effect.map((rows) => ({
              ...comment,
              reactions: forgejoReactions(rows ?? [], viewer),
            })),
          ),
        { concurrency: 4 },
      ),
      nextCursor:
        comments.length > 50 && last
          ? yield* encodeCommentsCursor([last.createdAt, Number(last.id)]).pipe(
              Effect.mapError((cause) =>
                failure("commentsPage", "Forgejo returned an invalid response.", cause),
              ),
            )
          : null,
    };
  });
  const pullReferences = (
    rows: ReadonlyArray<typeof ForgejoIssueTimeline.Type | null>,
    baseUrl: string,
    complete: boolean,
  ) => {
    const references = new Map<
      string,
      { repository: string; number: number; closesIssue: boolean; actionId: number }
    >();
    const base = new URL(baseUrl);
    const root = `${base.pathname.replace(/\/$/, "")}/`;
    for (const event of rows) {
      if (!event) continue;
      const ref = event.ref_issue;
      if (!ref?.pull_request || !URL.canParse(ref.html_url)) continue;
      const url = new URL(ref.html_url);
      if (url.origin !== base.origin || !url.pathname.startsWith(root)) continue;
      const match = /^([^/]+\/[^/]+)\/(?:issues|pulls)\/(\d+)$/.exec(
        url.pathname.slice(root.length),
      );
      if (!match || Number(match[2]) !== ref.number) continue;
      let repository: string;
      try {
        repository = match[1]!.split("/").map(decodeURIComponent).join("/");
      } catch {
        continue;
      }
      if (
        repository.split("/").length !== 2 ||
        repository.split("/").some((part) => !part || part === "." || part === "..")
      )
        continue;
      const key = `${repository}#${ref.number}`;
      const previous = references.get(key);
      const latestAction =
        complete &&
        (event.ref_action === "closes" || event.ref_action === "reopens") &&
        event.id > (previous?.actionId ?? 0);
      references.set(key, {
        repository,
        number: ref.number,
        closesIssue: latestAction
          ? event.ref_action === "closes"
          : (previous?.closesIssue ?? false),
        actionId: latestAction ? event.id : (previous?.actionId ?? 0),
      });
    }
    return [...references.values()].map((ref): readonly [string, number, boolean] => [
      ref.repository,
      ref.number,
      ref.closesIssue,
    ]);
  };
  const pullsPage = Effect.fn("ForgejoIssueProvider.pullsPage")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
    snapshot: PullsSnapshot,
  ) {
    const { refs, page } = snapshot;
    const mountPath = new URL(snapshot.baseUrl).pathname.replace(/^\/+|\/+$/g, "");
    const pulls = yield* Effect.forEach(
      refs.slice(0, 5),
      ([repository, number, closesIssue]) =>
        read(
          { ...input, repository, path: `${repoPath({ ...input, repository })}/pulls/${number}` },
          ForgejoIssueLinkedPullRequest,
        ).pipe(
          Effect.map((issue): IssueLinkedPullRequest[] => [
            {
              repository: mountPath ? `${mountPath}/${repository}` : repository,
              number: issue.number,
              title: issue.title,
              url: issue.html_url,
              state: issue.merged ? "merged" : issue.state === "closed" ? "closed" : "open",
              isDraft: issue.draft ?? false,
              closesIssue,
            },
          ]),
          Effect.catch((error) =>
            isForgejoCliError(error.cause) &&
            (error.cause.reason === "not-found" || error.cause.reason === "forbidden")
              ? Effect.succeed([])
              : Effect.fail(error),
          ),
        ),
      { concurrency: 2 },
    ).pipe(Effect.map((rows) => rows.flat()));
    const remaining = { ...snapshot, refs: refs.slice(5) };
    let nextCursor: string | null = null;
    if (remaining.refs.length > 0 || page !== null) {
      const encoded = yield* encodeSnapshot(remaining).pipe(
        Effect.mapError((cause) => failure("cursor", "Could not encode Forgejo snapshot.", cause)),
      );
      const snapshotId = Buffer.from(sha256(encoded)).toString("hex");
      nextCursor = yield* encodePageCursor(input, { kind: "pulls", snapshotId });
      yield* Cache.set(snapshots, nextCursor, remaining);
    }
    return {
      linkedPullRequests: pulls,
      nextCursor,
      truncated: nextCursor !== null || !remaining.complete,
    };
  });
  const linkedPullRequests = Effect.fn("ForgejoIssueProvider.linkedPullRequests")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    const target = yield* cli
      .resolveRepository(input)
      .pipe(Effect.mapError(fail("linkedPullRequests")));
    const base = new URL(target.baseUrl);
    const baseUrl = base.origin + base.pathname;
    const timeline = yield* readTimeline(input);
    const refs = pullReferences(timeline.rows, baseUrl, !timeline.truncated);
    const result = yield* pullsPage(input, {
      baseUrl,
      refs,
      seen: timeline.truncated ? refs.map((ref) => `${ref[0]}#${ref[1]}`) : [],
      complete: !timeline.truncated,
      page: timeline.nextPage,
    });
    return {
      linkedPullRequests: result.linkedPullRequests,
      linkedPullRequestsTruncated: result.truncated,
      nextLinkedPullRequestsCursor: result.nextCursor,
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
      const repository = yield* getRepository(input);
      const query = new URLSearchParams({ type: "issues", state: input.state, sort: "latest" });
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
      const sort = input.sort === "created" ? "createdAt" : "updatedAt";
      const direction = input.order === "asc" ? 1 : -1;
      const rows: ProviderIssue[] = [];
      const add = (
        issues: ReadonlyArray<typeof ForgejoIssue.Type>,
        lower = 0,
        upper = Infinity,
      ) => {
        for (const issue of issues) {
          if (issue.pull_request) continue;
          const item = forgejoIssue(issue);
          const updated = Math.floor(Date.parse(item.updatedAt) / 1000);
          if (updated < lower || updated > upper) continue;
          if (
            input.cursor &&
            (item.updatedAt > input.cursor.updatedBefore ||
              (item.updatedAt === input.cursor.updatedBefore &&
                input.cursor.seenAt?.includes(item.number)))
          )
            continue;
          rows.push(item);
        }
        rows.sort((a, b) => direction * (a[sort].localeCompare(b[sort]) || a.number - b.number));
        rows.length = Math.min(rows.length, input.limit + 1);
      };
      if (sort === "createdAt") {
        let page = 1;
        let reverse = false;
        for (;;) {
          const response = yield* readPage(
            { ...input, path: `${repoPath(input)}/issues?${query}` },
            ForgejoIssue,
            page,
          );
          if (!reverse && page === 1 && direction === 1 && response.lastPage !== null) {
            page = response.lastPage;
            reverse = true;
            if (page !== 1) continue;
          }
          add(response.rows);
          if ((direction === -1 || reverse) && rows.length > input.limit) {
            const boundary = rows[input.limit - 1]!.createdAt;
            if (
              response.rows.some(
                (issue) => direction * forgejoIssue(issue).createdAt.localeCompare(boundary) > 0,
              )
            )
              break;
          }
          if (reverse ? page === 1 : !response.more) break;
          page += reverse ? -1 : 1;
        }
      } else {
        const now = yield* Clock.currentTimeMillis;
        const ceiling = Math.floor(
          (input.cursor ? Date.parse(input.cursor.updatedBefore) : now) / 1000,
        );
        const created = repository.created_at
          ? Math.floor(Date.parse(repository.created_at) / 1000)
          : NaN;
        const floor = Number.isFinite(created) ? created : 0;
        let width = 86400;
        let upper =
          direction === -1 || !Number.isFinite(created)
            ? ceiling
            : Math.min(ceiling, floor + width);
        let lower =
          direction === -1 && Number.isFinite(created) ? Math.max(floor, upper - width + 1) : floor;
        for (;;) {
          query.set("before", DateTime.formatIso(DateTime.makeUnsafe((upper + 1) * 1000)));
          if (lower > floor)
            query.set("since", DateTime.formatIso(DateTime.makeUnsafe(lower * 1000)));
          else query.delete("since");
          let page = 1;
          let shrink = false;
          for (;;) {
            const response = yield* readPage(
              { ...input, path: `${repoPath(input)}/issues?${query}` },
              ForgejoIssue,
              page,
            );
            if (
              Number.isFinite(created) &&
              page === 1 &&
              upper > lower &&
              (response.totalCount !== null
                ? response.totalCount > Math.max(50, input.limit * 2)
                : response.more && response.rows.length >= 50)
            ) {
              width = Math.max(1, Math.floor((upper - lower + 1) / 2));
              if (direction === -1) lower = upper - width + 1;
              else upper = lower + width - 1;
              shrink = true;
              break;
            }
            add(response.rows, lower > floor ? lower : 0, upper);
            if (!response.more) break;
            page++;
          }
          if (shrink) continue;
          if (rows.length > input.limit || (direction === -1 ? lower <= floor : upper >= ceiling))
            break;
          width *= 2;
          if (direction === -1) {
            upper = lower - 1;
            lower = Math.max(floor, upper - width + 1);
          } else {
            lower = upper + 1;
            upper = Math.min(ceiling, lower + width - 1);
          }
        }
      }
      return {
        items: rows.slice(0, input.limit),
        truncated: rows.length > input.limit,
        continues: sort === "updatedAt" && direction === -1,
      };
    }),
    getIssueSummary: (input) => getIssue(input).pipe(Effect.map(forgejoIssue)),
    getIssue: Effect.fn("ForgejoIssueProvider.detail")(function* (input) {
      const [issue, repository, viewer, pulls] = yield* Effect.all(
        [getIssue(input), getRepository(input), getViewer(input), linkedPullRequests(input)],
        { concurrency: 3 },
      );
      return {
        ...forgejoIssue(issue),
        body: issue.body ?? "",
        viewer,
        ...(repository.html_url ? { repositoryUrl: repository.html_url } : {}),
        ...pulls,
        viewerPermissions: permissions(repository, issue, viewer),
      };
    }),
    getIssueActivity: Effect.fn("ForgejoIssueProvider.getIssueActivity")(function* (input) {
      const viewer = yield* getViewer(input);
      const timeline = yield* readTimeline(input);
      const rows = timeline.truncated
        ? ((yield* read(
            { ...input, path: `${issuePath(input)}/comments` },
            Schema.NullOr(Schema.Array(ForgejoComment)),
          )) ?? [])
        : timeline.rows.flatMap((row) => (row?.type === "comment" ? [row] : []));
      const [issue, comments, reactions] = yield* Effect.all(
        [
          getIssue(input),
          commentsPage(input, rows, viewer),
          readComplete({ ...input, path: `${issuePath(input)}/reactions` }, ForgejoReaction),
        ],
        { concurrency: 3 },
      );
      return {
        comments: comments.comments,
        commentCount: issue.comments ?? comments.comments.length,
        commentsTruncated: comments.nextCursor !== null,
        nextCommentsCursor: comments.nextCursor,
        reactions: forgejoReactions(reactions, viewer),
        eventsTruncated: timeline.truncated,
        nextEventsCursor:
          timeline.nextPage === null
            ? null
            : yield* encodePageCursor(input, { kind: "events", page: timeline.nextPage }),
        events: timeline.rows.flatMap((row) => {
          const event = row === null ? null : forgejoIssueEvent(row);
          return event ? [event] : [];
        }),
      };
    }),
    getIssueEvents: Effect.fn("ForgejoIssueProvider.getIssueEvents")(function* (input) {
      const cursor = yield* decodePageCursor(input);
      if (cursor?.kind !== "events")
        return yield* failure("getIssueEvents", "Invalid Forgejo events cursor.");
      const timeline = yield* readTimelinePages(input, cursor.page);
      return {
        events: timeline.rows.flatMap((row) => {
          const event = row === null ? null : forgejoIssueEvent(row);
          return event ? [event] : [];
        }),
        nextCursor:
          timeline.nextPage === null
            ? null
            : yield* encodePageCursor(input, { kind: "events", page: timeline.nextPage }),
        truncated: true,
      };
    }),
    getIssueLinkedPullRequests: Effect.fn("ForgejoIssueProvider.getIssueLinkedPullRequests")(
      function* (input) {
        const cursor = yield* decodePageCursor(input);
        if (cursor?.kind !== "pulls")
          return yield* failure(
            "getIssueLinkedPullRequests",
            "Invalid or expired Forgejo linked pull requests cursor. Refresh the issue to continue.",
          );
        const snapshot = yield* Cache.get(snapshots, input.cursor);
        if (snapshot.refs.length > 0 || snapshot.page === null)
          return yield* pullsPage(input, snapshot);
        const timeline = yield* readTimelinePages(input, snapshot.page);
        const seen = new Set(snapshot.seen);
        const refs = pullReferences(timeline.rows, snapshot.baseUrl, false).filter(
          (ref) => !seen.has(`${ref[0]}#${ref[1]}`),
        );
        return yield* pullsPage(input, {
          ...snapshot,
          refs,
          page: timeline.nextPage,
          seen: [...snapshot.seen, ...refs.map((ref) => `${ref[0]}#${ref[1]}`)],
        });
      },
    ),
    getIssueComments: Effect.fn("ForgejoIssueProvider.getIssueComments")(function* (input) {
      const cursor = decodeCommentsCursor(input.cursor);
      if (Result.isFailure(cursor))
        return yield* failure("getIssueComments", "Invalid Forgejo comments cursor.");
      const [rows, viewer] = yield* Effect.all(
        [
          read(
            { ...input, path: `${issuePath(input)}/comments` },
            Schema.NullOr(Schema.Array(ForgejoComment)),
          ),
          getViewer(input),
        ],
        { concurrency: 2 },
      );
      return yield* commentsPage(input, rows ?? [], viewer, cursor.success);
    }),
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
    setReaction: Effect.fn("ForgejoIssueProvider.setReaction")(function* (input) {
      if (input.subjectId !== undefined && !/^[1-9]\d*$/.test(input.subjectId))
        return yield* failure("setReaction", "Invalid Forgejo comment id.");
      const [issue, repository] = yield* Effect.all([getIssue(input), getRepository(input)], {
        concurrency: 2,
      });
      if (repository.archived || (issue.is_locked && !repository.permissions?.push))
        return yield* failure("setReaction", "This issue does not permit reactions.");
      let path = `${issuePath(input)}/reactions`;
      if (input.subjectId !== undefined) {
        const commentPath = `${repoPath(input)}/issues/comments/${input.subjectId}`;
        const comment = yield* read(
          { ...input, path: commentPath },
          Schema.Struct({ issue_url: Schema.String }),
        );
        const target = yield* cli
          .resolveRepository(input)
          .pipe(Effect.mapError(fail("setReaction")));
        const expected = `${target.baseUrl}/api/v1/${issuePath({ ...input, repository: target.repository })}`;
        if (comment.issue_url !== expected)
          return yield* failure("setReaction", "This comment belongs to another issue.");
        path = `${commentPath}/reactions`;
      }
      yield* write({
        ...input,
        path,
        method: input.reacted ? "POST" : "DELETE",
        body: { content: FORGEJO_REACTIONS[input.content] },
      });
    }),
    listIssueTemplates: Effect.fn("ForgejoIssueProvider.listIssueTemplates")(function* (input) {
      yield* getRepository(input);
      const [templates, config] = yield* Effect.all(
        [
          read(
            { ...input, path: `${repoPath(input)}/issue_templates` },
            Schema.NullOr(Schema.Array(ForgejoIssueTemplate)),
          ),
          read({ ...input, path: `${repoPath(input)}/issue_config` }, Schema.Unknown).pipe(
            Effect.map((value) => decodeIssueTemplateConfigYaml(JSON.stringify(value))),
            Effect.catch((error) =>
              isForgejoCliError(error.cause) && error.cause.reason === "not-found"
                ? Effect.succeed(DEFAULT_ISSUE_TEMPLATE_CONFIG)
                : Effect.fail(error),
            ),
          ),
        ],
        { concurrency: 2 },
      );
      return {
        ...config,
        templates: (templates ?? []).flatMap((template) => {
          const mapped = forgejoIssueTemplate(template);
          return mapped ? [mapped] : [];
        }),
      };
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
