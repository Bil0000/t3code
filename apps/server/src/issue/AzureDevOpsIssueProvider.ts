import * as Effect from "effect/Effect";
import type { IssueCapabilities, IssueViewerPermissions } from "@t3tools/contracts";

import * as AzureDevOpsIssueCli from "./AzureDevOpsIssueCli.ts";
import type { AzureDevOpsWorkItem } from "./azureDevOpsIssueJson.ts";
import {
  IssueProviderError,
  type IssueAdapter,
  type ProviderIssue,
  type ProviderIssueDetail,
} from "./IssueProvider.ts";

const CAPABILITIES: IssueCapabilities = {
  sorts: ["created", "updated", "comments"],
  referenceStyle: "hash",
  closesViaPullRequest: false,
  comment: true,
  actions: ["close", "reopen"],
  closeReasons: [],
  create: true,
  issueTemplates: true,
  edit: true,
  editComment: true,
  labels: true,
  assignees: true,
  maxAssignees: 1,
  typedAssignees: true,
  listLabelCandidates: true,
  listAssigneeCandidates: true,
  search: true,
  linkedPullRequests: false,
  timelineEvents: false,
};

/**
 * Everything this host offers, granted to whoever is signed in. Azure states no permission
 * anywhere `az boards` reaches: the answer lives in the security namespaces, behind identity
 * descriptors that would be several calls per work item to resolve.
 *
 * Controls stay live and a viewer who may not use one is told so by Azure, at the
 * moment they try — the safer half of an unknown, since hiding a control from somebody entitled
 * to it leaves them no way through and no reason given.
 */
const AZURE_DEVOPS_ISSUE_VIEWER_PERMISSIONS: IssueViewerPermissions = {
  actions: CAPABILITIES.actions,
  comment: CAPABILITIES.comment,
  edit: CAPABILITIES.edit,
  labels: CAPABILITIES.labels,
  assignees: CAPABILITIES.assignees,
  create: CAPABILITIES.create,
};

/** The CLI tags that mean the tool itself is unusable, rather than one request failing. */
function reasonFor(
  error: AzureDevOpsIssueCli.AzureDevOpsIssueCliError,
): IssueProviderError["reason"] {
  if (error._tag === "AzureDevOpsCliUnavailableError") return "missing-tool";
  if (error._tag === "AzureDevOpsCliAuthenticationError") return "unauthenticated";
  if (error._tag === "AzureDevOpsCliRateLimitError") return "rate-limited";
  if (error._tag === "AzureDevOpsIssueMutationRefusedError") {
    if (error.statusCode === 401) return "unauthenticated";
    if (error.statusCode === 429) return "rate-limited";
  }
  return "failed";
}

function toIssue(item: AzureDevOpsWorkItem): ProviderIssue {
  return {
    number: item.number,
    title: item.title,
    url: item.url,
    author: item.author,
    state: item.state,
    // Azure records which state a work item moved into, never why it was left.
    stateReason: null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    closedAt: item.closedAt,
    assignees: item.assignees,
    labels: item.labels,
    milestone: null,
    commentCount: item.commentCount,
  };
}

export const make = Effect.gen(function* () {
  const cli = yield* AzureDevOpsIssueCli.AzureDevOpsIssueCli;

  const fail =
    (operation: string) =>
    (error: AzureDevOpsIssueCli.AzureDevOpsIssueCliError): IssueProviderError => {
      const { detail } = error;
      return new IssueProviderError({
        provider: "azure-devops",
        operation,
        reason: reasonFor(error),
        detail,
        cause: error,
      });
    };

  return {
    kind: "azure-devops",
    capabilities: CAPABILITIES,

    getViewer: (input) => cli.getViewer(input).pipe(Effect.mapError(fail("getViewer"))),

    // Refused rather than answered with everything: Azure records no mention of a person on a
    // work item, and nothing between here and the reader narrows a listing back down — so the
    // page a mention filter would produce is every work item in the project.
    listIssues: (input) =>
      input.involvement === "mentioned"
        ? Effect.fail(
            new IssueProviderError({
              provider: "azure-devops",
              operation: "listIssues",
              reason: "failed",
              detail: "Azure DevOps records no mention of a person on a work item.",
            }),
          )
        : cli
            .listWorkItems({
              cwd: input.cwd,
              repository: input.repository,
              host: input.host,
              query: input.query,
              state: input.state,
              involvement: input.involvement,
              limit: input.limit,
              sort: input.sort,
              order: input.order,
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            })
            .pipe(
              Effect.mapError(fail("listIssues")),
              Effect.map((page) => ({
                items: page.items.map(toIssue),
                truncated: page.truncated,
                continues:
                  (input.sort === undefined || input.sort === "updated") && input.order !== "asc",
              })),
            ),

    getIssue: (input) =>
      cli.getWorkItem(input).pipe(
        Effect.mapError(fail("getIssue")),
        Effect.map((item): ProviderIssueDetail => ({
          ...toIssue(item),
          body: item.description,
          linkedPullRequests: [],
          viewerPermissions: AZURE_DEVOPS_ISSUE_VIEWER_PERMISSIONS,
        })),
      ),

    getIssueSummary: (input) =>
      cli.getWorkItemSummary(input).pipe(Effect.mapError(fail("getIssueSummary"))),

    getIssueActivity: (input) =>
      cli.listComments(input).pipe(
        Effect.mapError(fail("getIssueActivity")),
        Effect.map((page) => ({
          comments: page.comments,
          commentCount: page.commentCount,
          commentsTruncated: page.nextCursor !== null,
          nextCommentsCursor: page.nextCursor,
          events: [],
        })),
      ),

    getIssueComments: (input) =>
      cli.listComments(input).pipe(
        Effect.mapError(fail("getIssueComments")),
        Effect.map((page) => ({ comments: page.comments, nextCursor: page.nextCursor })),
      ),

    // No request at all: Azure has nothing to say about the viewer that a work item read reaches.
    getViewerPermissions: () => Effect.succeed(AZURE_DEVOPS_ISSUE_VIEWER_PERMISSIONS),

    runAction: (input) => cli.runWorkItemAction(input).pipe(Effect.mapError(fail("runAction"))),

    comment: (input) => cli.comment(input).pipe(Effect.mapError(fail("comment"))),

    updateComment: (input) => cli.comment(input).pipe(Effect.mapError(fail("updateComment"))),

    create: (input) => cli.createWorkItem(input).pipe(Effect.mapError(fail("create"))),

    update: (input) => cli.updateWorkItem(input).pipe(Effect.mapError(fail("update"))),

    setLabels: (input) => cli.updateWorkItem(input).pipe(Effect.mapError(fail("setLabels"))),

    setAssignees: (input) => cli.updateWorkItem(input).pipe(Effect.mapError(fail("setAssignees"))),

    listLabelCandidates: (input) =>
      cli.listTagCandidates(input).pipe(Effect.mapError(fail("listLabelCandidates"))),

    listAssigneeCandidates: (input) =>
      cli.listAssigneeCandidates(input).pipe(Effect.mapError(fail("listAssigneeCandidates"))),

    listIssueTemplates: (input) =>
      cli.listWorkItemTypes(input).pipe(
        Effect.mapError(fail("listIssueTemplates")),
        Effect.map((workItemTypes) => ({
          templates: [],
          contactLinks: [],
          blankIssuesEnabled: true,
          workItemTypes,
        })),
      ),
  } satisfies IssueAdapter;
});
