import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LinearTeam = Schema.Struct({
  id: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type LinearTeam = typeof LinearTeam.Type;

export const LinearConnection = Schema.Struct({
  status: Schema.Literals(["authenticated", "unauthenticated", "unverified"]),
  hasStoredToken: Schema.Boolean,
  accountName: Schema.NullOr(TrimmedNonEmptyString),
  accountEmail: Schema.NullOr(TrimmedNonEmptyString),
  teams: Schema.Array(LinearTeam),
});
export type LinearConnection = typeof LinearConnection.Type;

export const LinearConnectInput = Schema.Struct({
  token: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
});

export const LinearProjectTeamInput = Schema.Struct({
  projectId: ProjectId,
  teamKey: Schema.NullOr(TrimmedNonEmptyString),
});

export class IssueTrackingError extends Schema.TaggedErrorClass<IssueTrackingError>()(
  "IssueTrackingError",
  {
    operation: Schema.Literals(["status", "connect", "disconnect", "set-project-team"]),
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Issue tracking ${this.operation} failed: ${this.detail}`;
  }
}
