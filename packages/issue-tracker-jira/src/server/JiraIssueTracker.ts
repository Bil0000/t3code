import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  IssueCapabilities,
  IssuePageInput,
  IssueRelation,
  IssueViewerPermissions,
  StandaloneIssueTrackerDescriptor,
} from "@t3tools/contracts";
import type {
  IssueTarget,
  IssueScopeTarget,
  StandaloneIssueTrackerApi,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as JiraApi from "./JiraApi.ts";
import {
  JiraIssue,
  JiraUser,
  JiraStatus,
  JiraComment,
  JiraHistoryEntry,
  jiraBodyText,
  jiraBodyEditable,
  textToAdf,
  normalizeJiraIssue,
  buildJql,
  jiraActor,
  jiraState,
  jiraDate,
  jiraEvents,
  quoteJiraJql,
} from "./jiraJson.ts";
import { jiraRichBody, parseJiraRichBody } from "./jiraAdf.ts";
import {
  JiraField,
  createReserved,
  transitionReserved,
  jiraInputFields,
  jiraFieldValues,
} from "./jiraForms.ts";

const DESCRIPTOR: StandaloneIssueTrackerDescriptor = {
  tracker: JiraApi.KIND,
  displayName: "Jira",
  host: null,
  scopeNoun: "project",
  credential: {
    label: "API token",
    helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    fields: [
      { key: "site", label: "Jira site", secret: false },
      {
        key: "deployment",
        label: "Deployment (cloud or data-center)",
        secret: false,
        optional: true,
      },
      { key: "email", label: "Account email (Cloud)", secret: false, optional: true },
      { key: "token", label: "API token", secret: true },
    ],
  },
};

const CAPABILITIES: IssueCapabilities = {
  create: true,
  createIssueTypes: true,
  createFields: true,
  stateFields: true,
  richText: true,
  edit: true,
  comment: true,
  editComment: true,
  subIssues: true,
  createSubIssue: true,
  updateParent: true,
  listSorts: ["created", "updated"],
  listOrders: ["asc", "desc"],
  labels: true,
  assignees: true,
  maxAssignees: 1,
  involvements: ["all", "assigned", "authored"],
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: true,
  search: true,
  states: [
    { name: "open", category: "open" },
    { name: "closed", category: "closed" },
  ],
  closeReasons: [],
};

const Text = Schema.String.check(Schema.isMinLength(1));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const bounded = <S extends Schema.Top>(schema: S, maximum = 100) =>
  Schema.Array(schema).check(Schema.isMaxLength(maximum));
const Search = Schema.Struct({
  issues: bounded(JiraIssue, 200),
  nextPageToken: Schema.optional(Text.check(Schema.isMaxLength(4096))),
  isLast: Schema.optional(Schema.Boolean),
});
const Permissions = Schema.Struct({
  permissions: Schema.Record(Schema.String, Schema.Struct({ havePermission: Schema.Boolean })),
});
const Transitions = Schema.Struct({
  transitions: bounded(
    Schema.Struct({
      id: Text,
      name: Schema.optional(Text),
      to: JiraStatus,
      isAvailable: Schema.optional(Schema.Boolean),
      fields: Schema.optional(Schema.Record(Schema.String, JiraField)),
    }),
  ),
});
const Types = Schema.Struct({
  startAt: Count,
  total: Schema.optional(Count),
  isLast: Schema.optional(Schema.Boolean),
  issueTypes: bounded(
    Schema.Struct({ id: Text, name: Text, subtask: Schema.optional(Schema.Boolean) }),
  ),
});
const Fields = Schema.Struct({
  startAt: Count,
  total: Schema.optional(Count),
  isLast: Schema.optional(Schema.Boolean),
  fields: bounded(JiraField),
});
const CommentPage = Schema.Struct({
  startAt: Count,
  total: Count,
  comments: bounded(JiraComment, 50),
});
const History = Schema.Struct({
  startAt: Schema.optional(Count),
  total: Schema.optional(Count),
  isLast: Schema.optional(Schema.Boolean),
  values: bounded(JiraHistoryEntry, 200),
});
const ScopeIssue = Schema.Struct({
  key: Text,
  fields: Schema.Struct({
    project: Schema.Struct({ id: Text, key: Text }),
    status: JiraStatus,
    description: Schema.optional(Schema.Unknown),
  }),
});
const issueFields = [
  "project",
  "parent",
  "issuetype",
  "summary",
  "description",
  "status",
  "creator",
  "assignee",
  "labels",
  "created",
  "updated",
  "resolutiondate",
  "comment",
  "fixVersions",
];
const permissionNames =
  "CREATE_ISSUES,EDIT_ISSUES,ADD_COMMENTS,ASSIGN_ISSUES,TRANSITION_ISSUES,EDIT_ALL_COMMENTS,EDIT_OWN_COMMENTS";
const commentOffset = (cursor: string) => {
  if (!/^(0|[1-9][0-9]{0,8})$/.test(cursor)) throw new Error("Invalid Jira comment cursor.");
  return Number(cursor);
};
const matchesState = (
  transition: (typeof Transitions.Type)["transitions"][number],
  state: string,
) => (transition.to.statusCategory.key === "done") === (state === "closed");
const transitionFields = (transition: (typeof Transitions.Type)["transitions"][number]) => {
  const fields = transition.fields ?? {};
  if (Object.keys(fields).length > 100) throw new Error("Too many Jira transition fields.");
  return fields;
};
const RemoteLinks = bounded(
  Schema.Struct({
    object: Schema.Struct({
      title: Text.check(Schema.isMaxLength(4096)),
      url: Text.check(Schema.isMaxLength(8192)),
    }),
  }),
);
const safeRemoteLink = (link: (typeof RemoteLinks.Type)[number]) => {
  try {
    const url = new URL(link.object.url);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? [{ title: link.object.title, url: link.object.url }]
      : [];
  } catch {
    return [];
  }
};
const metadataProgress = (
  page: {
    readonly startAt: number;
    readonly total?: number | undefined;
    readonly isLast?: boolean | undefined;
  },
  startAt: number,
  count: number,
  total: number | undefined,
) => {
  const next = startAt + count;
  if (
    page.startAt !== startAt ||
    next > 100 ||
    (page.total === undefined && page.isLast === undefined) ||
    (page.total !== undefined && (page.total > 100 || page.total < next)) ||
    (total !== undefined && page.total !== total) ||
    (page.isLast === true && page.total !== undefined && page.total !== next) ||
    (page.isLast === false && page.total !== undefined && page.total === next)
  )
    throw new Error("Inconsistent Jira metadata page.");
  const more = page.isLast === false || (page.isLast !== true && next < (page.total ?? next));
  if (more && (count === 0 || next >= 100)) throw new Error("Incomplete Jira metadata.");
  return { total: page.total, more };
};
const formAttempt = <A>(operation: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: () =>
      JiraApi.failed(
        operation,
        "Check extra required fields and allowed values in this Jira form.",
      ),
  });

export const make = Effect.gen(function* () {
  const jira = yield* JiraApi.JiraApi;
  const requireIssue = (input: IssueTarget) =>
    Effect.gen(function* () {
      const issue = yield* jira.request({
        host: input.host,
        operation: "getIssue",
        method: "GET",
        path:
          "/issue/" +
          encodeURIComponent(input.key) +
          "?fields=" +
          issueFields.join(",") +
          "&expand=changelog",
        schema: JiraIssue,
      });
      if (
        !issue.fields.project ||
        (issue.fields.project.key !== input.scope && issue.fields.project.id !== input.scope)
      )
        return yield* JiraApi.failed(
          "getIssue",
          "This issue is outside the selected Jira project.",
          "not-found",
        );
      return issue;
    });
  const requireScopeIssue = (input: IssueTarget, operation: string, description = false) =>
    Effect.gen(function* () {
      const issue = yield* jira.request({
        host: input.host,
        operation,
        method: "GET",
        path:
          "/issue/" +
          encodeURIComponent(input.key) +
          "?fields=project,status" +
          (description ? ",description" : ""),
        schema: ScopeIssue,
      });
      if (issue.fields.project.key !== input.scope && issue.fields.project.id !== input.scope)
        return yield* JiraApi.failed(
          operation,
          "This issue is outside the selected Jira project.",
          "not-found",
        );
      return issue;
    });
  const permissions = (
    input: IssueScopeTarget & { readonly key?: string | undefined },
    operation: string,
  ) =>
    jira.request({
      host: input.host,
      operation,
      method: "GET",
      path:
        "/mypermissions?" +
        (input.key
          ? "issueKey=" + encodeURIComponent(input.key)
          : (/^[0-9]+$/.test(input.scope) ? "projectId=" : "projectKey=") +
            encodeURIComponent(input.scope)) +
        "&permissions=" +
        permissionNames,
      schema: Permissions,
    });
  const transitions = (input: IssueTarget) =>
    jira.request({
      host: input.host,
      operation: "transitions",
      method: "GET",
      path: "/issue/" + encodeURIComponent(input.key) + "/transitions?expand=transitions.fields",
      schema: Transitions,
    });
  const viewer = (host: string) =>
    jira
      .request({ host, operation: "getViewer", method: "GET", path: "/myself", schema: JiraUser })
      .pipe(Effect.map((user) => user.accountId));
  const allowed = (raw: typeof Permissions.Type, key: string) =>
    raw.permissions[key]?.havePermission === true;
  const toPermissions = (raw: typeof Permissions.Type): IssueViewerPermissions => ({
    edit: allowed(raw, "EDIT_ISSUES"),
    labels: allowed(raw, "EDIT_ISSUES"),
    assignees: allowed(raw, "ASSIGN_ISSUES"),
    comment: allowed(raw, "ADD_COMMENTS"),
    setState: allowed(raw, "TRANSITION_ISSUES"),
  });
  const commentResult = (
    input: IssueTarget,
    page: {
      readonly startAt: number;
      readonly total: number;
      readonly comments: ReadonlyArray<typeof JiraComment.Type>;
    },
    granted?: typeof Permissions.Type,
    deployment: "cloud" | "data-center" = "cloud",
  ) =>
    JiraApi.attempt("getComments", () => {
      if (page.comments.length === 0 && page.startAt < page.total)
        throw new Error("Incomplete Jira comment page.");
      return {
        comments: page.comments.map((comment) => {
          const richBody = jiraRichBody(comment.body, deployment);
          return {
            id: comment.id,
            author: comment.author ? jiraActor(comment.author) : null,
            body: jiraBodyText(comment.body),
            ...(richBody === undefined ? {} : { richBody }),
            createdAt: jiraDate(comment.created),
            editedAt: comment.created === comment.updated ? null : jiraDate(comment.updated),
            canEdit:
              granted !== undefined &&
              (allowed(granted, "EDIT_ALL_COMMENTS") ||
                (input.viewer !== undefined &&
                  input.viewer === comment.author?.accountId &&
                  allowed(granted, "EDIT_OWN_COMMENTS"))) &&
              ((deployment === "cloud" && jiraBodyEditable(comment.body)) ||
                richBody !== undefined),
            url:
              JiraApi.jiraIssueUrl(input.host, input.key) +
              "?focusedCommentId=" +
              encodeURIComponent(comment.id),
          };
        }),
        nextCursor:
          page.startAt + page.comments.length < page.total
            ? String(page.startAt + page.comments.length)
            : null,
      };
    });
  const comments = (
    input: IssueTarget,
    startAt: number,
    granted?: typeof Permissions.Type,
    deployment: "cloud" | "data-center" = "cloud",
  ) =>
    Effect.gen(function* () {
      const page = yield* jira.request({
        host: input.host,
        operation: "getComments",
        method: "GET",
        path:
          "/issue/" +
          encodeURIComponent(input.key) +
          "/comment?orderBy=-created&startAt=" +
          startAt +
          "&maxResults=50",
        schema: CommentPage,
      });
      if (page.startAt !== startAt || (page.comments.length === 0 && startAt < page.total))
        return yield* JiraApi.failed("getComments", "Jira returned an inconsistent comment page.");
      return yield* commentResult(
        input,
        { ...page, comments: page.comments.toReversed() },
        granted,
        deployment,
      );
    });
  const issueTypes = (input: IssueScopeTarget) =>
    Effect.gen(function* () {
      const types: Array<(typeof Types.Type)["issueTypes"][number]> = [];
      let total: number | undefined;
      let more: boolean;
      do {
        const startAt = types.length;
        const page = yield* jira.request({
          host: input.host,
          operation: "issueTypes",
          method: "GET",
          path:
            "/issue/createmeta/" +
            encodeURIComponent(input.scope) +
            "/issuetypes?startAt=" +
            startAt +
            "&maxResults=100",
          schema: Types,
        });
        const progress = yield* JiraApi.attempt("issueTypes", () =>
          metadataProgress(page, startAt, page.issueTypes.length, total),
        );
        total = progress.total;
        more = progress.more;
        types.push(...page.issueTypes);
      } while (more);
      if (new Set(types.map((type) => type.id)).size !== types.length)
        return yield* JiraApi.failed("issueTypes", "Jira returned duplicate issue types.");
      return types;
    });
  const createFields = (input: IssueScopeTarget, issueType: string, operation: string) =>
    Effect.gen(function* () {
      const fields: Array<typeof JiraField.Type> = [];
      let total: number | undefined;
      let more: boolean;
      do {
        const startAt = fields.length;
        const page = yield* jira.request({
          host: input.host,
          operation,
          method: "GET",
          path:
            "/issue/createmeta/" +
            encodeURIComponent(input.scope) +
            "/issuetypes/" +
            encodeURIComponent(issueType) +
            "?startAt=" +
            startAt +
            "&maxResults=100",
          schema: Fields,
        });
        const progress = yield* JiraApi.attempt(operation, () =>
          metadataProgress(page, startAt, page.fields.length, total),
        );
        total = progress.total;
        more = progress.more;
        fields.push(...page.fields);
      } while (more);
      return yield* JiraApi.attempt(operation, () => {
        const result: Record<string, typeof JiraField.Type> = {};
        for (const field of fields) {
          if (
            !field.fieldId ||
            ["__proto__", "constructor", "prototype"].includes(field.fieldId) ||
            Object.hasOwn(result, field.fieldId)
          )
            throw new Error("Invalid Jira form field.");
          result[field.fieldId] = field;
        }
        return result;
      });
    });
  const pageLimit = (operation: string, input: IssuePageInput) => {
    const limit = input.limit ?? 100;
    return !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      (input.cursor !== undefined && (!input.cursor || input.cursor.length > 4096))
      ? Effect.fail(JiraApi.failed(operation, "Invalid Jira page."))
      : Effect.succeed(limit);
  };
  const relation = (issue: typeof JiraIssue.Type, host: string, scope: string): IssueRelation => ({
    scope:
      issue.fields.project?.key === scope || issue.fields.project?.id === scope
        ? scope
        : issue.fields.project!.key,
    key: issue.key,
    displayKey: issue.key,
    title: issue.fields.summary,
    url: JiraApi.jiraIssueUrl(host, issue.key),
    state: jiraState(issue.fields.status),
  });

  const richDocument = (
    cloud: boolean,
    operation: string,
    richBody: Parameters<typeof parseJiraRichBody>[0],
  ) =>
    JiraApi.attempt(operation, () =>
      parseJiraRichBody(richBody, cloud ? "cloud" : "data-center", operation === "editComment"),
    );
  const api: StandaloneIssueTrackerApi = {
    kind: JiraApi.KIND,
    standalone: DESCRIPTOR,
    capabilities: CAPABILITIES,
    probeCredential: jira.probeCredential,
    listScopes: jira.listScopes,
    getScope: jira.getScope,
    getViewer: (input) => viewer(input.host),
    listIssues: (input) =>
      Effect.gen(function* () {
        if (input.scope.trim() === "")
          return yield* JiraApi.failed("listIssues", "Choose a Jira project.");
        if (
          !Number.isInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 200 ||
          (input.cursor !== undefined && (!input.cursor || input.cursor.length > 4096))
        )
          return yield* JiraApi.failed("listIssues", "Invalid Jira issue page.");
        const jql = yield* Effect.try({
          try: () => buildJql(input),
          catch: () => JiraApi.failed("listIssues", "Jira does not support mention filtering."),
        });
        if (jql === null) return { items: [], nextCursor: null };
        const page = yield* jira.request({
          host: input.host,
          operation: "listIssues",
          method: "POST",
          path: "/search/jql",
          schema: Search,
          body: {
            jql,
            maxResults: input.limit,
            fields: issueFields.filter((field) => field !== "description"),
            ...(input.cursor === undefined ? {} : { nextPageToken: input.cursor }),
          },
        });
        if (
          page.issues.length > input.limit ||
          (page.isLast === false && !page.nextPageToken) ||
          (input.cursor !== undefined && page.nextPageToken === input.cursor) ||
          page.issues.some(
            (issue) =>
              !issue.fields.project ||
              (issue.fields.project.key !== input.scope && issue.fields.project.id !== input.scope),
          )
        )
          return yield* JiraApi.failed("listIssues", "Jira returned an inconsistent issue page.");
        return {
          items: yield* JiraApi.attempt("listIssues", () =>
            page.issues.map((issue) => normalizeJiraIssue(issue, input.host)),
          ),
          nextCursor: page.isLast === true ? null : (page.nextPageToken ?? null),
        };
      }),
    getIssue: (input) =>
      Effect.gen(function* () {
        const issue = yield* requireIssue(input);
        const remoteLinksRequest = jira.request({
          host: input.host,
          operation: "getIssue",
          method: "GET",
          path: "/issue/" + encodeURIComponent(input.key) + "/remotelink",
          schema: RemoteLinks,
        });
        const [who, rawPermissions, remoteLinks, deployment] = yield* Effect.all(
          [
            viewer(input.host),
            permissions(input, "getIssue"),
            remoteLinksRequest,
            jira.deploymentFor(input.host),
          ],
          { concurrency: 4 },
        );
        const embedded = issue.fields.comment;
        const page =
          embedded?.comments === undefined && embedded?.total !== 0
            ? yield* comments({ ...input, viewer: who }, 0, rawPermissions, deployment)
            : yield* commentResult(
                { ...input, viewer: who },
                {
                  startAt: 0,
                  total: embedded?.total ?? 0,
                  comments: embedded?.comments ?? [],
                },
                rawPermissions,
                deployment,
              );
        const history = issue.changelog
          ? { ...issue.changelog, values: issue.changelog.histories, isLast: undefined }
          : yield* jira.request({
              host: input.host,
              operation: "getIssue",
              method: "GET",
              path:
                "/issue/" + encodeURIComponent(input.key) + "/changelog?startAt=0&maxResults=50",
              schema: History,
            });
        const richBody = jiraRichBody(issue.fields.description, deployment);
        return {
          ...(yield* JiraApi.attempt("getIssue", () => normalizeJiraIssue(issue, input.host))),
          body: yield* JiraApi.attempt("getIssue", () => jiraBodyText(issue.fields.description)),
          bodyEditable: yield* JiraApi.attempt(
            "getIssue",
            () => deployment === "cloud" && jiraBodyEditable(issue.fields.description),
          ),
          ...(richBody === undefined ? {} : { richBody }),
          ...(deployment === "cloud"
            ? {}
            : { capabilities: { ...CAPABILITIES, updateParent: false } }),
          externalLinks: remoteLinks.flatMap(safeRemoteLink),
          states: [jiraState(issue.fields.status)],
          viewer: who,
          viewerPermissions: {
            ...toPermissions(rawPermissions),
            ...(deployment === "cloud" ? {} : { updateParent: false }),
          },
          comments: page.comments,
          commentsCursor: page.nextCursor,
          events: yield* JiraApi.attempt("getIssue", () => jiraEvents(history.values)),
          historyTruncated:
            (history.startAt ?? 0) > 0 ||
            history.values.length < (history.total ?? history.values.length) ||
            history.isLast === false,
          linkedPullRequests: [],
        };
      }),
    getComments: (input) =>
      Effect.gen(function* () {
        yield* requireScopeIssue(input, "getComments");
        const startAt = yield* JiraApi.attempt("getComments", () => commentOffset(input.cursor));
        return yield* comments(
          input,
          startAt,
          input.viewer === undefined ? undefined : yield* permissions(input, "getComments"),
          yield* jira.deploymentFor(input.host),
        );
      }),
    getViewerPermissions: (input) =>
      Effect.gen(function* () {
        const raw = yield* permissions(input, "getViewerPermissions");
        return {
          ...toPermissions(raw),
          ...((yield* jira.deploymentFor(input.host)) === "cloud" ? {} : { updateParent: false }),
        };
      }),
    create: (input) =>
      Effect.gen(function* () {
        if (input.assignees.length > 1)
          return yield* JiraApi.failed("create", "A Jira issue can have only one assignee.");
        const parent =
          input.parentKey === undefined
            ? null
            : yield* requireIssue({ ...input, key: input.parentKey });
        const types = yield* issueTypes(input);
        const availableTypes =
          parent === null ? types.filter((type) => type.subtask !== true) : types;
        const selected =
          input.issueType === undefined
            ? availableTypes.length === 1
              ? availableTypes[0]
              : undefined
            : types.find((type) => type.id === input.issueType);
        if (!selected) return yield* JiraApi.failed("create", "Select a Jira issue type first.");
        if (selected.subtask === true && parent === null)
          return yield* JiraApi.failed("create", "Select a parent issue for this Jira subtask.");
        if (input.templateKey !== undefined)
          return yield* JiraApi.failed("create", "Jira issue templates are not supported.");
        const metadata = yield* createFields(input, selected.id, "create");
        const cloud = (yield* jira.deploymentFor(input.host)) === "cloud";
        const nativeFields = yield* formAttempt("create", () =>
          jiraFieldValues(metadata, input.fieldValues, createReserved, cloud),
        );
        const primaryValues = {
          summary: input.title,
          description: input.body,
          labels: input.labels,
          assignee: input.assignees,
          parent: parent?.key,
        };
        yield* formAttempt("create", () => {
          for (const [id, value] of Object.entries(primaryValues)) {
            const field = metadata[id];
            const empty =
              value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
            if (field?.required && !field.hasDefaultValue && empty)
              throw new Error("Missing required Jira field.");
            if (field?.operations !== undefined && !field.operations.includes("set") && !empty)
              throw new Error("This Jira field cannot be set.");
          }
        });
        const fields = new Set(Object.keys(metadata));
        if (
          (parent !== null && selected.subtask !== true && !fields.has("parent")) ||
          (input.body !== "" && !fields.has("description")) ||
          (input.labels.length > 0 && !fields.has("labels")) ||
          (input.assignees.length > 0 && !fields.has("assignee"))
        )
          return yield* JiraApi.failed(
            "create",
            "This Jira issue type does not allow the selected description, labels or assignee on creation.",
          );
        const body = yield* JiraApi.attempt("create", () =>
          cloud ? textToAdf(input.body) : input.body,
        );
        const created = yield* jira.request({
          host: input.host,
          operation: "create",
          method: "POST",
          path: "/issue",
          schema: Schema.Struct({ key: Text }),
          body: {
            fields: {
              ...nativeFields,
              project: /^[0-9]+$/.test(input.scope) ? { id: input.scope } : { key: input.scope },
              issuetype: { id: selected.id },
              summary: input.title,
              ...(parent === null ? {} : { parent: { key: parent.key } }),
              ...(fields.has("description") &&
              !(metadata.description?.hasDefaultValue && input.body === "")
                ? { description: body }
                : {}),
              ...(fields.has("labels") &&
              !(metadata.labels?.hasDefaultValue && input.labels.length === 0)
                ? { labels: input.labels }
                : {}),
              ...(input.assignees[0] === undefined
                ? {}
                : { assignee: { accountId: input.assignees[0] } }),
            },
          },
        });
        return {
          ...(parent === null ? {} : { parentLinked: true }),
          key: created.key,
          displayKey: created.key,
          url: JiraApi.jiraIssueUrl(input.host, created.key),
        };
      }),
    comment: (input) =>
      Effect.gen(function* () {
        yield* requireScopeIssue(input, "comment");
        const cloud = (yield* jira.deploymentFor(input.host)) === "cloud";
        const body = yield* JiraApi.attempt("comment", () =>
          cloud ? textToAdf(input.body) : input.body,
        );
        yield* jira.request({
          host: input.host,
          operation: "comment",
          method: "POST",
          path: "/issue/" + encodeURIComponent(input.key) + "/comment",
          schema: JiraComment,
          body: { body },
        });
      }),
    editComment: (input) =>
      Effect.gen(function* () {
        yield* requireScopeIssue(input, "editComment");
        const path =
          "/issue/" +
          encodeURIComponent(input.key) +
          "/comment/" +
          encodeURIComponent(input.commentId);
        const comment = yield* jira.request({
          host: input.host,
          operation: "editComment",
          method: "GET",
          path,
          schema: JiraComment,
        });
        const cloud = (yield* jira.deploymentFor(input.host)) === "cloud";
        if (
          input.richBody === undefined &&
          (!cloud || !(yield* JiraApi.attempt("editComment", () => jiraBodyEditable(comment.body))))
        )
          return yield* JiraApi.failed(
            "editComment",
            "This comment has rich content. Edit it in Jira to preserve its formatting and attachments.",
          );
        const body =
          input.richBody === undefined
            ? yield* JiraApi.attempt("editComment", () =>
                cloud ? textToAdf(input.body) : input.body,
              )
            : yield* richDocument(cloud, "editComment", input.richBody);
        yield* jira.request({
          host: input.host,
          operation: "editComment",
          method: "PUT",
          path,
          schema: JiraComment,
          body: { body },
        });
      }),
    getHierarchy: (input) =>
      Effect.gen(function* () {
        const limit = yield* pageLimit("getHierarchy", input);
        const current = yield* requireIssue(input);
        const parent =
          current.fields.parent === null || current.fields.parent === undefined
            ? null
            : yield* jira.request({
                host: input.host,
                operation: "getHierarchy",
                method: "GET",
                path:
                  "/issue/" +
                  encodeURIComponent(current.fields.parent.key) +
                  "?fields=" +
                  issueFields.filter((field) => field !== "description").join(","),
                schema: JiraIssue,
              });
        const page = yield* jira.request({
          host: input.host,
          operation: "getHierarchy",
          method: "POST",
          path: "/search/jql",
          schema: Search,
          body: {
            jql: "parent = " + quoteJiraJql(current.key) + " ORDER BY created DESC",
            fields: issueFields.filter((field) => field !== "description"),
            maxResults: limit,
            ...(input.cursor === undefined ? {} : { nextPageToken: input.cursor }),
          },
        });
        if (
          page.issues.length > limit ||
          (page.isLast === false && !page.nextPageToken) ||
          (input.cursor !== undefined && page.nextPageToken === input.cursor) ||
          page.issues.some(
            (child) =>
              child.fields.parent?.key !== current.key || child.fields.project === undefined,
          ) ||
          (parent !== null && parent.fields.project === undefined)
        )
          return yield* JiraApi.failed(
            "getHierarchy",
            "Jira returned an inconsistent child issue page.",
          );
        return {
          parent: parent === null ? null : relation(parent, input.host, input.scope),
          children: {
            items: page.issues.map((child) => relation(child, input.host, input.scope)),
            nextCursor: page.isLast === true ? null : (page.nextPageToken ?? null),
          },
        };
      }),
    setParent: (input) =>
      Effect.gen(function* () {
        if ((yield* jira.deploymentFor(input.host)) === "data-center")
          return yield* JiraApi.failed(
            "setParent",
            "Change this issue's parent in Jira Data Center.",
          );
        const selected = yield* requireIssue(input);
        if (input.parentKey === null && selected.fields.issuetype?.subtask === true)
          return yield* JiraApi.failed(
            "setParent",
            "Jira subtasks must have a parent. Change the issue type in Jira first.",
          );
        const parent =
          input.parentKey === null ? null : yield* requireIssue({ ...input, key: input.parentKey });
        if (parent?.key === selected.key)
          return yield* JiraApi.failed("setParent", "An issue cannot be its own parent.");
        yield* jira.request({
          host: input.host,
          operation: "setParent",
          method: "PUT",
          path: "/issue/" + encodeURIComponent(selected.key),
          schema: Schema.Undefined,
          body:
            parent === null
              ? { update: { parent: [{ set: { none: true } }] } }
              : { fields: { parent: { key: parent.key } } },
        });
      }),
    getHistory: (input) =>
      Effect.gen(function* () {
        const limit = yield* pageLimit("getHistory", input);
        const startAt = yield* JiraApi.attempt("getHistory", () =>
          commentOffset(input.cursor ?? "0"),
        );
        yield* requireScopeIssue(input, "getHistory");
        const page = yield* jira.request({
          host: input.host,
          operation: "getHistory",
          method: "GET",
          path:
            "/issue/" +
            encodeURIComponent(input.key) +
            "/changelog?startAt=" +
            startAt +
            "&maxResults=" +
            limit,
          schema: History,
        });
        if (
          page.startAt !== startAt ||
          page.values.length > limit ||
          (page.values.length === 0 && (page.isLast === false || startAt < (page.total ?? 0)))
        )
          return yield* JiraApi.failed("getHistory", "Jira returned an inconsistent history page.");
        const more =
          page.isLast === false ||
          (page.isLast !== true && startAt + page.values.length < (page.total ?? 0));
        return {
          items: yield* JiraApi.attempt("getHistory", () => jiraEvents(page.values)),
          nextCursor: more ? String(startAt + page.values.length) : null,
        };
      }),
    listLabelCandidates: (input) =>
      Effect.gen(function* () {
        const limit = yield* pageLimit("listLabelCandidates", input);
        const page = yield* jira.request({
          host: input.host,
          operation: "listLabelCandidates",
          method: "POST",
          path: "/search/jql",
          schema: Search,
          body: {
            jql: "project = " + quoteJiraJql(input.scope) + " ORDER BY updated DESC",
            fields: issueFields.filter((field) => field !== "description"),
            maxResults: limit,
            ...(input.cursor === undefined ? {} : { nextPageToken: input.cursor }),
          },
        });
        if (
          page.issues.length > limit ||
          (page.isLast === false && !page.nextPageToken) ||
          (input.cursor !== undefined && page.nextPageToken === input.cursor) ||
          page.issues.some(
            (issue) =>
              !issue.fields.project ||
              (issue.fields.project.key !== input.scope && issue.fields.project.id !== input.scope),
          )
        )
          return yield* JiraApi.failed(
            "listLabelCandidates",
            "Jira returned labels outside this project or an inconsistent page.",
          );
        return {
          items: [...new Set(page.issues.flatMap((issue) => issue.fields.labels ?? []))].map(
            (name) => ({ name, color: null, description: null }),
          ),
          nextCursor: page.isLast === true ? null : (page.nextPageToken ?? null),
        };
      }),
    listAssigneeCandidates: (input) =>
      Effect.gen(function* () {
        const limit = yield* pageLimit("listAssigneeCandidates", input);
        const startAt = yield* JiraApi.attempt("listAssigneeCandidates", () =>
          commentOffset(input.cursor ?? "0"),
        );
        const cloud = (yield* jira.deploymentFor(input.host)) === "cloud";
        if (!cloud && startAt !== 0)
          return yield* JiraApi.failed(
            "listAssigneeCandidates",
            "Jira Data Center assignee search has no next page.",
          );
        if (startAt >= 1000)
          return yield* JiraApi.failed(
            "listAssigneeCandidates",
            "Jira assignee search is limited to the first 1000 users.",
          );
        const window = Math.min(limit, cloud ? 1000 - startAt : 100);
        const users = yield* jira.request({
          host: input.host,
          operation: "listAssigneeCandidates",
          method: "GET",
          path:
            "/user/assignable/search?project=" +
            encodeURIComponent(input.scope) +
            "&startAt=" +
            startAt +
            "&maxResults=" +
            window,
          schema: bounded(JiraUser, 200),
        });
        if (users.length > window)
          return yield* JiraApi.failed(
            "listAssigneeCandidates",
            "Jira returned too many assignees.",
          );
        return {
          items: users.map(jiraActor),
          nextCursor: cloud && startAt + window < 1000 ? String(startAt + window) : null,
          ...(cloud
            ? startAt + window >= 1000
              ? { truncated: true }
              : {}
            : users.length === window
              ? { truncated: true }
              : {}),
        };
      }),
    update: (input) =>
      Effect.gen(function* () {
        if (input.assignees !== undefined && input.assignees.length > 1)
          return yield* JiraApi.failed("update", "A Jira issue can have only one assignee.");
        const issue = yield* requireScopeIssue(
          input,
          "update",
          input.body !== undefined || input.richBody !== undefined,
        );
        const cloud = (yield* jira.deploymentFor(input.host)) === "cloud";
        if (
          input.body !== undefined &&
          input.richBody === undefined &&
          (!cloud ||
            !(yield* JiraApi.attempt("update", () => jiraBodyEditable(issue.fields.description))))
        )
          return yield* JiraApi.failed(
            "update",
            "This description has rich content. Edit it in Jira to preserve its formatting and attachments.",
          );
        const text = input.body;
        const body =
          input.richBody !== undefined
            ? yield* richDocument(cloud, "update", input.richBody)
            : text === undefined
              ? undefined
              : yield* JiraApi.attempt("update", () => (cloud ? textToAdf(text) : text));
        const fields = {
          ...(input.title === undefined ? {} : { summary: input.title }),
          ...(body === undefined ? {} : { description: body }),
          ...(input.labels === undefined ? {} : { labels: input.labels }),
          ...(input.assignees === undefined
            ? {}
            : {
                assignee:
                  input.assignees[0] === undefined ? null : { accountId: input.assignees[0] },
              }),
        };
        if (Object.keys(fields).length === 0) return;
        const assigneeOnly = input.assignees !== undefined && Object.keys(fields).length === 1;
        yield* jira.request({
          host: input.host,
          operation: "update",
          method: "PUT",
          path: "/issue/" + encodeURIComponent(input.key) + (assigneeOnly ? "/assignee" : ""),
          schema: Schema.Undefined,
          body: assigneeOnly ? { accountId: input.assignees?.[0] ?? null } : { fields },
        });
      }),
    setState: (input) =>
      Effect.gen(function* () {
        if (input.closeReason !== undefined)
          return yield* JiraApi.failed(
            "setState",
            "Choose a Jira workflow transition without a close reason.",
          );
        const issue = yield* requireScopeIssue(input, "setState");
        if (
          input.transitionId === undefined &&
          Object.keys(input.fieldValues ?? {}).length === 0 &&
          (issue.fields.status.id === input.state ||
            issue.fields.status.name === input.state ||
            ((input.state === "open" || input.state === "closed") &&
              (issue.fields.status.statusCategory.key === "done") === (input.state === "closed")))
        )
          return;
        const available = yield* transitions(input);
        const candidates = available.transitions.filter(
          (transition) =>
            transition.isAvailable !== false &&
            (input.transitionId === undefined || transition.id === input.transitionId) &&
            (transition.to.id === input.state ||
              transition.to.name === input.state ||
              ((input.state === "open" || input.state === "closed") &&
                matchesState(transition, input.state))),
        );
        const transition = candidates.length === 1 ? candidates[0] : undefined;
        if (!transition)
          return yield* JiraApi.failed(
            "setState",
            "Choose one available Jira workflow transition.",
          );
        const cloud = (yield* jira.deploymentFor(input.host)) === "cloud";
        const fields = yield* formAttempt("setState", () =>
          jiraFieldValues(
            transitionFields(transition),
            input.fieldValues,
            transitionReserved,
            cloud,
          ),
        );
        yield* jira.request({
          host: input.host,
          operation: "setState",
          method: "POST",
          path: "/issue/" + encodeURIComponent(input.key) + "/transitions",
          schema: Schema.Undefined,
          body: {
            transition: { id: transition.id },
            ...(Object.keys(fields).length === 0 ? {} : { fields }),
          },
        });
      }),
    listCandidates: (input) =>
      Effect.gen(function* () {
        const issueTarget = input.key === undefined ? null : { ...input, key: input.key };
        if (issueTarget !== null) yield* requireScopeIssue(issueTarget, "listCandidates");
        const raw = yield* permissions(input, "listCandidates");
        const available = issueTarget === null ? null : yield* transitions(issueTarget);
        const sample = yield* jira.request({
          host: input.host,
          operation: "listCandidates",
          method: "POST",
          path: "/search/jql",
          schema: Schema.Struct({
            issues: bounded(
              Schema.Struct({
                fields: Schema.Struct({
                  project: Schema.Struct({ id: Text, key: Text }),
                  labels: Schema.Array(Text),
                }),
              }),
            ),
          }),
          body: {
            jql: "project = " + quoteJiraJql(input.scope) + " ORDER BY updated DESC",
            maxResults: 100,
            fields: ["project", "labels"],
          },
        });
        if (
          sample.issues.some(
            (issue) =>
              issue.fields.project.key !== input.scope && issue.fields.project.id !== input.scope,
          )
        )
          return yield* JiraApi.failed(
            "listCandidates",
            "Jira returned labels outside this project.",
          );
        const users = allowed(raw, "ASSIGN_ISSUES")
          ? yield* jira.request({
              host: input.host,
              operation: "listCandidates",
              method: "GET",
              path:
                "/user/assignable/search?project=" +
                encodeURIComponent(input.scope) +
                "&startAt=0&maxResults=100",
              schema: bounded(JiraUser),
            })
          : [];
        const types = allowed(raw, "CREATE_ISSUES") ? yield* issueTypes(input) : [];
        if (input.issueType !== undefined && !types.some((type) => type.id === input.issueType))
          return yield* JiraApi.failed("listCandidates", "Select an available Jira issue type.");
        const fields =
          input.issueType === undefined
            ? undefined
            : yield* createFields(input, input.issueType, "listCandidates").pipe(
                Effect.flatMap((metadata) =>
                  JiraApi.attempt("listCandidates", () =>
                    jiraInputFields(metadata, createReserved),
                  ),
                ),
              );
        const statuses =
          available === null
            ? (yield* jira.request({
                host: input.host,
                operation: "listCandidates",
                method: "GET",
                path: "/project/" + encodeURIComponent(input.scope) + "/statuses",
                schema: bounded(Schema.Struct({ statuses: bounded(JiraStatus) })),
              })).flatMap((type) => type.statuses)
            : [];
        const nativeStates = [...new Map(statuses.map((status) => [status.id, status])).values()];
        if (nativeStates.length > 100)
          return yield* JiraApi.failed(
            "listCandidates",
            "This Jira project has too many states to load here.",
          );
        return {
          states:
            available === null
              ? nativeStates.map(jiraState)
              : yield* JiraApi.attempt("listCandidates", () =>
                  available.transitions
                    .filter((transition) => transition.isAvailable !== false)
                    .map((transition) => ({
                      ...jiraState(transition.to),
                      name: transition.name ?? transition.to.name,
                      transitionId: transition.id,
                      fields: jiraInputFields(transitionFields(transition), transitionReserved),
                    })),
                ),
          ...(fields === undefined ? {} : { fields }),
          labels: [...new Set(sample.issues.flatMap((issue) => issue.fields.labels))]
            .slice(0, 100)
            .map((name) => ({ name, color: null, description: null })),
          assignees: users.map((user) => ({ ...jiraActor(user), id: user.accountId })),
          issueTypes: types.map((type) => ({ id: type.id, name: type.name })),
          truncated: true,
        };
      }),
  };
  return api;
});
