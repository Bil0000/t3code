import * as Schema from "effect/Schema";

import { PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const WorkItemTaskMode = Schema.Literals(["compound", "subtasks"]);
export type WorkItemTaskMode = typeof WorkItemTaskMode.Type;

export const WorkItemTaskSourceRef = Schema.Struct({
  kind: Schema.Literals(["issue", "pull-request"]),
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type WorkItemTaskSourceRef = typeof WorkItemTaskSourceRef.Type;

export const WorkItemTaskInput = Schema.Struct({
  projectId: ProjectId,
  mode: WorkItemTaskMode,
  items: Schema.Array(WorkItemTaskSourceRef).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
});
export type WorkItemTaskInput = typeof WorkItemTaskInput.Type;

export const WorkItemTaskResult = Schema.Struct({
  prompt: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(65_536)),
  generated: Schema.Boolean,
});
export type WorkItemTaskResult = typeof WorkItemTaskResult.Type;

export class WorkItemTaskError extends Schema.TaggedErrorClass<WorkItemTaskError>()(
  "WorkItemTaskError",
  {
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Work item task generation failed: ${this.detail}`;
  }
}
