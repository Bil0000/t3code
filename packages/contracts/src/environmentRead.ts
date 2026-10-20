import * as Schema from "effect/Schema";
import { EnvironmentId, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { Project } from "./project.ts";
import {
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
} from "./orchestratorMcp.ts";
import {
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
} from "./threadSearch.ts";

const Page = {
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
};
export const EnvironmentReadRequest = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("project.list"), ...Page }),
  Schema.Struct({ operation: Schema.Literal("project.read"), projectId: ProjectId }),
  Schema.Struct({
    ...OrchestratorMcpThreadListInput.fields,
    operation: Schema.Literal("thread.list"),
    projectId: ProjectId,
  }),
  Schema.Struct({
    ...OrchestrationSearchThreadsInput.fields,
    operation: Schema.Literal("thread.search"),
  }),
  Schema.Struct({
    ...OrchestratorMcpThreadReadInput.fields,
    operation: Schema.Literal("thread.read"),
  }),
]);
export type EnvironmentReadRequest = typeof EnvironmentReadRequest.Type;
export const EnvironmentReadResult = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("project.list"),
    data: Schema.Struct({
      projects: Schema.Array(Project),
      nextCursor: Schema.NullOr(NonNegativeInt),
    }),
  }),
  Schema.Struct({ operation: Schema.Literal("project.read"), data: Project }),
  Schema.Struct({
    operation: Schema.Literal("thread.list"),
    data: OrchestratorMcpThreadListResult,
  }),
  Schema.Struct({
    operation: Schema.Literal("thread.search"),
    data: OrchestrationSearchThreadsResult,
  }),
  Schema.Struct({
    operation: Schema.Literal("thread.read"),
    data: OrchestratorMcpThreadReadResult,
  }),
]);
export type EnvironmentReadResult = typeof EnvironmentReadResult.Type;
export const EnvironmentReadTarget = Schema.Struct({
  environmentId: EnvironmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  status: Schema.Literals(["online", "offline", "unsupported", "permission-denied"]),
});
export type EnvironmentReadTarget = typeof EnvironmentReadTarget.Type;
export const EnvironmentReadRegistration = Schema.Struct({
  clientId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  environments: Schema.Array(EnvironmentReadTarget).check(Schema.isMaxLength(100)),
});
export type EnvironmentReadRegistration = typeof EnvironmentReadRegistration.Type;
export const EnvironmentReadStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected"), connectionId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("request"),
    connectionId: Schema.String,
    requestId: Schema.String,
    environmentId: EnvironmentId,
    request: EnvironmentReadRequest,
  }),
]);
export type EnvironmentReadStreamEvent = typeof EnvironmentReadStreamEvent.Type;
const EnvironmentReadErrorCode = Schema.Literals([
  "offline",
  "permission-denied",
  "unsupported",
  "not-found",
  "timeout",
  "invalid-response",
  "too-large",
]);
export const EnvironmentReadResponse = Schema.Struct({
  clientId: EnvironmentReadRegistration.fields.clientId,
  connectionId: Schema.String,
  requestId: Schema.String,
  response: Schema.Union([
    Schema.Struct({ status: Schema.Literal("ok"), result: EnvironmentReadResult }),
    Schema.Struct({ status: Schema.Literal("error"), code: EnvironmentReadErrorCode }),
  ]),
});
export type EnvironmentReadResponse = typeof EnvironmentReadResponse.Type;
export class EnvironmentReadError extends Schema.TaggedError<EnvironmentReadError>()(
  "EnvironmentReadError",
  {
    code: EnvironmentReadErrorCode,
    environmentId: Schema.optional(EnvironmentId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Environment read failed: ${this.code}.`;
  }
}
export const EnvironmentBrowseInput = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
  request: EnvironmentReadRequest,
});
export type EnvironmentBrowseInput = typeof EnvironmentBrowseInput.Type;
export const EnvironmentBrowseResult = Schema.Struct({
  environmentId: EnvironmentId,
  result: EnvironmentReadResult,
});
export const ENVIRONMENT_READ_WS_METHODS = {
  subscribe: "environmentRead.subscribe",
  respond: "environmentRead.respond",
  read: "environmentRead.read",
} as const;
