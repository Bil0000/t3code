import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class PullRequestBranchDeletionError extends Schema.TaggedErrorClass<PullRequestBranchDeletionError>()(
  "PullRequestBranchDeletionError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

export const assertSourceBranchDeletable = (input: {
  readonly state: string;
  readonly sourceRepository: string;
  readonly baseRepository: string;
  readonly sourceBranch: string;
  readonly baseBranch: string;
  readonly defaultBranch: string;
}) => {
  const state = input.state.toLowerCase();
  const detail =
    !input.sourceRepository.trim() ||
    !input.baseRepository.trim() ||
    !input.sourceBranch.trim() ||
    !input.baseBranch.trim() ||
    !input.defaultBranch.trim()
      ? "The host did not identify the source and target repositories and their branches."
      : !["closed", "merged", "declined", "superseded", "completed", "abandoned"].includes(state)
        ? "Close or merge the pull request before deleting its source branch."
        : (input.sourceRepository === input.baseRepository &&
              input.sourceBranch === input.baseBranch) ||
            input.sourceBranch === input.defaultBranch
          ? "The default branch or target branch cannot be deleted."
          : null;
  return detail === null
    ? Effect.void
    : Effect.fail(new PullRequestBranchDeletionError({ detail }));
};

export const decodeBranchDeletionJson = <
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  schema: S,
  raw: string,
) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      () =>
        new PullRequestBranchDeletionError({
          detail: "The host did not return enough branch data to delete the source branch safely.",
        }),
    ),
  );
