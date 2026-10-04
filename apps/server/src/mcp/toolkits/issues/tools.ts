import {
  IssueOperationError,
  IssueProviderKind,
  IssueUnavailableError,
  McpCapabilityUnavailableError,
  PositiveInt,
  PullRequestOperationError,
  PullRequestUnavailableError,
  ThreadIssueLink,
  TrimmedNonEmptyString,
  WorkItemLink,
  WorkItemLinkError,
  WorkItemLinksResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as IssueService from "../../../issue/IssueService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as WorkItemLinks from "../../../workItems/WorkItemLinks.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const IssueTargetInput = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  provider: Schema.optional(IssueProviderKind),
});

export class IssueThreadNotFoundError extends Schema.TaggedError<IssueThreadNotFoundError>()(
  "IssueThreadNotFoundError",
  { threadId: Schema.String },
) {}

export class IssueThreadLinkFailedError extends Schema.TaggedError<IssueThreadLinkFailedError>()(
  "IssueThreadLinkFailedError",
  { cause: Schema.Defect() },
) {}

export const IssueToolError = Schema.Union([
  McpCapabilityUnavailableError,
  IssueUnavailableError,
  IssueOperationError,
  IssueThreadNotFoundError,
  IssueThreadLinkFailedError,
  WorkItemLinkError,
  PullRequestOperationError,
  PullRequestUnavailableError,
]);

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  Orchestrator.OrchestratorV2,
  IssueService.IssueService,
];

const LinkIssueTool = Tool.make("link_issue", {
  description:
    "Link an issue in this thread's project to this thread. Use after taking work on an issue. The link appears with the thread and its pull requests. Linking the same issue again succeeds with alreadyLinked=true.",
  parameters: IssueTargetInput,
  success: Schema.Struct({ issue: ThreadIssueLink, alreadyLinked: Schema.Boolean }),
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link issue to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkIssueTool = Tool.make("unlink_issue", {
  description:
    "Remove an issue link from this thread. Pass its URL when the same repository and number are linked from more than one host. The issue itself stays unchanged. Unlinking an issue that is not linked succeeds with wasLinked=false.",
  parameters: Schema.Struct({
    ...IssueTargetInput.fields,
    url: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({ wasLinked: Schema.Boolean }),
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Unlink issue from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadIssuesTool = Tool.make("list_thread_issues", {
  description: "List issues linked to this thread.",
  success: Schema.Struct({ issues: Schema.Array(ThreadIssueLink) }),
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "List thread issues")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReadIssueTool = Tool.make("read_issue", {
  description:
    "Read an issue in this thread's project: its description, labels, state, and newest comments. Works for any issue, linked or not. Prefer it over tracker CLIs. The markdown says when comments were left out.",
  parameters: Schema.Struct({
    ...IssueTargetInput.fields,
    commentsCursor: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          "nextCommentsCursor from a previous read_issue call, to read the earlier comments before that page.",
      }),
    ),
  }),
  success: Schema.Struct({
    markdown: Schema.String.annotate({
      description: "The issue and a page of its comments as markdown.",
    }),
    nextCommentsCursor: Schema.NullOr(Schema.String).annotate({
      description:
        "Pass back as commentsCursor to read earlier comments; null when there are none to page to.",
    }),
  }),
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read issue")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const PullRequestTargetInput = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  host: Schema.optional(TrimmedNonEmptyString),
});

const IssuePullRequestTargetInput = Schema.Struct({
  issue: IssueTargetInput,
  pullRequest: PullRequestTargetInput,
});

const linkDependencies = [
  ...dependencies,
  PullRequestService.PullRequestService,
  WorkItemLinks.WorkItemLinks,
];

const LinkIssueToPullRequestTool = Tool.make("link_issue_to_pull_request", {
  description:
    "Save a local link between an issue and pull request. Both references use this thread's project. This does not edit either host item.",
  parameters: IssuePullRequestTargetInput,
  success: WorkItemLink,
  failure: IssueToolError,
  dependencies: linkDependencies,
})
  .annotate(Tool.Title, "Link issue to pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkIssueFromPullRequestTool = Tool.make("unlink_issue_from_pull_request", {
  description:
    "Remove a saved local issue and pull request link. Both references must still be readable from this thread's project. Neither host item is changed.",
  parameters: IssuePullRequestTargetInput,
  success: Schema.Void,
  failure: IssueToolError,
  dependencies: linkDependencies,
})
  .annotate(Tool.Title, "Unlink issue from pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListIssuePullRequestLinksTool = Tool.make("list_issue_pull_request_links", {
  description:
    "List saved local issue and pull request links for an item readable from this thread's project.",
  parameters: Schema.Struct({
    source: Schema.Struct({
      kind: Schema.Literals(["issue", "pull-request"]),
      repository: TrimmedNonEmptyString,
      number: PositiveInt,
      provider: Schema.optional(IssueProviderKind),
      host: Schema.optional(TrimmedNonEmptyString),
    }),
  }),
  success: WorkItemLinksResult,
  failure: IssueToolError,
  dependencies: linkDependencies,
})
  .annotate(Tool.Title, "List issue and pull request links")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const IssuesToolkit = Toolkit.make(
  LinkIssueTool,
  UnlinkIssueTool,
  ListThreadIssuesTool,
  ReadIssueTool,
  LinkIssueToPullRequestTool,
  UnlinkIssueFromPullRequestTool,
  ListIssuePullRequestLinksTool,
);
