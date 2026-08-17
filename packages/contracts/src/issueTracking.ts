import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LinearTeam = Schema.Struct({
  id: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type LinearTeam = typeof LinearTeam.Type;

export const LinearAccount = Schema.Struct({
  credentialId: TrimmedNonEmptyString,
  status: Schema.Literals(["authenticated", "unauthenticated", "unverified"]),
  accountName: TrimmedNonEmptyString,
  accountEmail: Schema.NullOr(TrimmedNonEmptyString),
  teams: Schema.Array(LinearTeam),
});
export type LinearAccount = typeof LinearAccount.Type;

export const LinearConnection = Schema.Struct({
  status: Schema.Literals(["authenticated", "unauthenticated", "unverified"]),
  hasStoredToken: Schema.Boolean,
  accountName: Schema.NullOr(TrimmedNonEmptyString),
  accountEmail: Schema.NullOr(TrimmedNonEmptyString),
  teams: Schema.Array(LinearTeam),
  accounts: Schema.Array(LinearAccount).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type LinearConnection = typeof LinearConnection.Type;

export const LinearConnectInput = Schema.Struct({
  token: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
});

export const LinearDisconnectInput = Schema.Union([
  Schema.Struct({ credentialId: TrimmedNonEmptyString }),
  Schema.Undefined,
]);
export type LinearDisconnectInput = typeof LinearDisconnectInput.Type;

export class IssueTrackingError extends Schema.TaggedErrorClass<IssueTrackingError>()(
  "IssueTrackingError",
  {
    operation: Schema.Literals(["status", "connect", "disconnect"]),
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Issue tracking ${this.operation} failed: ${this.detail}`;
  }
}
