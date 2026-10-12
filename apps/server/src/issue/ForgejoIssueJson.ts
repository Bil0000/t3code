import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { IssueComment, IssueEvent } from "@t3tools/contracts";
import {
  ForgejoComment,
  ForgejoLabel,
  ForgejoRepository,
  ForgejoUser,
  forgejoActor,
} from "@t3tools/source-control-forgejo/server/forgejoPullRequestJson";
import type { ProviderIssue } from "./IssueProvider.ts";

export const ForgejoIssue = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.String,
  user: Schema.NullOr(ForgejoUser),
  state: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(ForgejoUser))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(ForgejoLabel))),
  milestone: Schema.optional(Schema.NullOr(Schema.Struct({ title: Schema.String }))),
  comments: Schema.optional(Schema.Int),
  is_locked: Schema.optional(Schema.Boolean),
  pull_request: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

export const ForgejoIssueRepository = Schema.Struct({
  ...ForgejoRepository.fields,
  html_url: Schema.optional(Schema.String),
  has_issues: Schema.optional(Schema.Boolean),
});

export const ForgejoIssueTimeline = Schema.Struct({
  ...ForgejoComment.fields,
  type: Schema.String,
  assignee: Schema.optional(Schema.NullOr(ForgejoUser)),
  removed_assignee: Schema.optional(Schema.Boolean),
  new_title: Schema.optional(Schema.String),
  milestone: Schema.optional(Schema.NullOr(Schema.Struct({ title: Schema.String }))),
  label: Schema.optional(Schema.NullOr(ForgejoLabel)),
});

function isoDate(value: string): string {
  return Option.match(DateTime.make(value), { onNone: () => value, onSome: DateTime.formatIso });
}

export function forgejoIssue(issue: typeof ForgejoIssue.Type): ProviderIssue {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    author: forgejoActor(issue.user),
    state: issue.state === "closed" ? "closed" : "open",
    stateReason: null,
    createdAt: isoDate(issue.created_at),
    updatedAt: isoDate(issue.updated_at),
    closedAt: issue.closed_at ? isoDate(issue.closed_at) : null,
    assignees: (issue.assignees ?? []).flatMap((user) => {
      const actor = forgejoActor(user);
      return actor ? [actor] : [];
    }),
    labels: (issue.labels ?? []).map((label) => ({ name: label.name, color: label.color ?? null })),
    milestone: issue.milestone?.title ?? null,
    commentCount: issue.comments ?? 0,
  };
}

export function forgejoIssueComment(comment: typeof ForgejoComment.Type): IssueComment {
  return {
    id: String(comment.id),
    author: forgejoActor(comment.user),
    body: comment.body,
    createdAt: isoDate(comment.created_at),
    url: comment.html_url || null,
  };
}

export function forgejoIssueEvent(event: typeof ForgejoIssueTimeline.Type): IssueEvent | null {
  let kind: IssueEvent["kind"];
  let detail: string | null = null;
  switch (event.type) {
    case "close":
      kind = "closed";
      break;
    case "reopen":
      kind = "reopened";
      break;
    case "lock":
      kind = "locked";
      break;
    case "unlock":
      kind = "unlocked";
      break;
    case "assignees":
      kind = event.removed_assignee ? "unassigned" : "assigned";
      detail = event.assignee?.login || null;
      break;
    case "change_title":
      kind = "renamed";
      detail = event.new_title || null;
      break;
    case "milestone":
      kind = "milestoned";
      detail = event.milestone?.title || null;
      break;
    case "label":
      if (event.body !== "1" && event.body !== "") return null;
      kind = event.body === "1" ? "labeled" : "unlabeled";
      detail = event.label?.name || null;
      break;
    case "issue_ref":
    case "commit_ref":
    case "comment_ref":
    case "pull_ref":
      kind = "referenced";
      break;
    default:
      return null;
  }
  return {
    id: String(event.id),
    kind,
    actor: forgejoActor(event.user),
    createdAt: isoDate(event.created_at),
    detail,
  };
}
