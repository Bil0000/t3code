import { CommandId, IssueOperationError, type ThreadIssueLink } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as IssueService from "../../../issue/IssueService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { IssueThreadLinkFailedError, IssueThreadNotFoundError, IssuesToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const issues = yield* IssueService.IssueService;
  const crypto = yield* Crypto.Crypto;

  const requireThread = Effect.fn("IssuesToolkit.requireThread")(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("issues");
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(Effect.mapError((cause) => new IssueThreadLinkFailedError({ cause })));
    if (Option.isNone(thread)) {
      return yield* new IssueThreadNotFoundError({ threadId: scope.threadId });
    }
    return thread.value;
  });

  const commandId = (threadId: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:mcp-issue:${threadId}:${uuid}`)),
    );

  const dispatchFailure = <E>(cause: Cause.Cause<E>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(new IssueThreadLinkFailedError({ cause }));

  return IssuesToolkit.of({
    link_issue: (input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread();
        const detail = yield* issues.detail({
          projectId: thread.projectId,
          repository: input.repository,
          number: input.number,
          ...(input.provider === undefined ? {} : { provider: input.provider }),
        });
        const issue: ThreadIssueLink = {
          provider: detail.provider,
          repository: detail.repository,
          number: detail.number,
          url: detail.url,
          title: detail.title,
        };
        const alreadyLinked = yield* engine
          .dispatch({
            type: "thread.meta.update",
            commandId: yield* commandId(thread.id),
            threadId: thread.id,
            issueLink: issue,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTags({
              OrchestrationCommandInvariantError: (error) =>
                error.detail.includes("already linked") ? Effect.succeed(true) : Effect.fail(error),
            }),
            Effect.catchCause(dispatchFailure),
          );
        return { issue, alreadyLinked };
      }),
    unlink_issue: (input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread();
        const matches = (thread.issues ?? []).filter(
          (issue) =>
            issue.repository.toLowerCase() === input.repository.toLowerCase() &&
            issue.number === input.number &&
            (input.provider === undefined || issue.provider === input.provider),
        );
        if (matches.length > 1) {
          return yield* new IssueOperationError({
            operation: "unlink",
            detail: "More than one provider matches this issue. Pass provider.",
          });
        }
        const issue = matches[0];
        if (!issue) return { wasLinked: false };
        const wasLinked = yield* engine
          .dispatch({
            type: "thread.meta.update",
            commandId: yield* commandId(thread.id),
            threadId: thread.id,
            issueUnlink: {
              provider: issue.provider,
              repository: issue.repository,
              number: issue.number,
            },
          })
          .pipe(
            Effect.as(true),
            Effect.catchTags({
              OrchestrationCommandInvariantError: (error) =>
                error.detail.includes("not linked") ? Effect.succeed(false) : Effect.fail(error),
            }),
            Effect.catchCause(dispatchFailure),
          );
        return { wasLinked };
      }),
    list_thread_issues: () =>
      requireThread().pipe(Effect.map((thread) => ({ issues: thread.issues ?? [] }))),
  });
});

export const IssuesToolkitHandlersLive = IssuesToolkit.toLayer(make);
