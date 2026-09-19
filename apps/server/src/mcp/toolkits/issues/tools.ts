import {
  IssueOperationError,
  IssueProviderKind,
  IssueUnavailableError,
  McpCapabilityUnavailableError,
  PositiveInt,
  ThreadIssueLink,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as IssueService from "../../../issue/IssueService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
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
]);

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
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
    "Remove an issue link from this thread. The issue itself stays unchanged. Unlinking an issue that is not linked succeeds with wasLinked=false.",
  parameters: IssueTargetInput,
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

export const IssuesToolkit = Toolkit.make(LinkIssueTool, UnlinkIssueTool, ListThreadIssuesTool);
