import type * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  IssueState,
  IssueActor,
  IssueComment,
  IssueLabel,
  IssueEvent,
  IssueReactionContent,
} from "@t3tools/contracts";
import { IsoDateTime, PositiveInt } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

/**
 * A work item as this wrapper needs it. Azure keeps everything under `fields`, keyed by reference
 * name, and reports no shape of its own for what a project has added — so only the fields every
 * work item type carries are read, and anything else is left where it is.
 */
export interface AzureDevOpsWorkItem {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: IssueActor | null;
  readonly assignees: ReadonlyArray<IssueActor>;
  readonly state: IssueState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly description: string;
  readonly commentCount: number;
  readonly labels: ReadonlyArray<IssueLabel>;
  readonly project: string | null;
  readonly relations?: ReadonlyArray<typeof Relation.Type>;
}

/**
 * The states Azure treats as finished. A project may rename its own columns, so anything not
 * named here reads as open: an issue wrongly shown as open is one the reader can still close,
 * while one wrongly shown as closed disappears from the list they were looking at.
 */
const CLOSED_STATES = new Set(["closed", "done", "removed", "resolved", "completed"]);

const Identity = Schema.Struct({
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  uniqueName: Schema.optional(Schema.NullOr(Schema.String)),
  imageUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const Fields = Schema.Struct({
  "System.CommentCount": Schema.optional(Schema.NullOr(Schema.Int)),
  "System.Title": Schema.optional(Schema.NullOr(Schema.String)),
  "System.State": Schema.optional(Schema.NullOr(Schema.String)),
  "System.CreatedDate": Schema.optional(Schema.NullOr(Schema.String)),
  "System.ChangedDate": Schema.optional(Schema.NullOr(Schema.String)),
  "Microsoft.VSTS.Common.ClosedDate": Schema.optional(Schema.NullOr(Schema.String)),
  "System.Description": Schema.optional(Schema.NullOr(Schema.String)),
  "System.Tags": Schema.optional(Schema.NullOr(Schema.String)),
  "System.TeamProject": Schema.optional(Schema.NullOr(Schema.String)),
  "System.CreatedBy": Schema.optional(Schema.NullOr(Schema.Union([Identity, Schema.String]))),
  "System.AssignedTo": Schema.optional(Schema.NullOr(Schema.Union([Identity, Schema.String]))),
});

const Relation = Schema.Struct({
  rel: Schema.String,
  url: Schema.String,
});

const WorkItem = Schema.Struct({
  id: Schema.Union([Schema.Int, Schema.String]),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  fields: Schema.optional(Schema.NullOr(Fields)),
  relations: Schema.optional(Schema.NullOr(Schema.Array(Relation))),
});

const decodeWorkItem = Schema.decodeUnknownResult(WorkItem);
const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeUnknownItem = decodeJsonResult(Schema.Unknown);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

/**
 * The organization link `az` returns addresses the REST resource, which is not a page anybody
 * can open. The one a reader wants is the board's own item, which Azure spells this way.
 */
function browserUrl(
  apiUrl: string | null | undefined,
  id: number,
  project?: string | null,
): string | null {
  if (apiUrl === null || apiUrl === undefined) return null;
  const match =
    /^(https?:\/\/(?:[^/]+\.visualstudio\.com(?:\/DefaultCollection)?|[^/]+\/[^/]+))(?:\/([^/]+))?\/_apis\/wit\/workItems\//iu.exec(
      apiUrl,
    );
  if (match === null) return null;
  const projectPath = match[2] ?? (project ? encodeURIComponent(project) : null);
  return `${match[1]}${projectPath === null ? "" : `/${projectPath}`}/_workitems/edit/${id}`;
}

function actorOf(value: unknown): IssueActor | null {
  if (typeof value === "string") {
    const login = value.trim();
    return login.length === 0 ? null : { login, name: null, avatarUrl: null };
  }
  if (value === null || typeof value !== "object") return null;
  const identity = value as typeof Identity.Type;
  const login = (identity.uniqueName ?? identity.displayName ?? "").trim();
  if (login.length === 0) return null;
  return {
    login,
    name: identity.displayName ?? null,
    avatarUrl: identity.imageUrl ?? null,
  };
}

function toWorkItem(raw: unknown): AzureDevOpsWorkItem | null {
  const decoded = decodeWorkItem(raw);
  if (!Result.isSuccess(decoded)) return null;
  const item = decoded.success;
  const number = typeof item.id === "string" ? Number.parseInt(item.id, 10) : item.id;
  if (!Number.isInteger(number) || number <= 0) return null;
  const fields = item.fields ?? {};
  const title = (fields["System.Title"] ?? "").trim();
  const createdAt = fields["System.CreatedDate"] ?? null;
  const updatedAt = fields["System.ChangedDate"] ?? createdAt;
  const url = browserUrl(item.url, number, fields["System.TeamProject"]);
  if (title.length === 0 || createdAt === null || updatedAt === null || url === null) return null;
  const assignee = actorOf(fields["System.AssignedTo"]);
  return {
    number,
    title,
    url,
    author: actorOf(fields["System.CreatedBy"]),
    assignees: assignee === null ? [] : [assignee],
    state: CLOSED_STATES.has((fields["System.State"] ?? "").trim().toLowerCase())
      ? "closed"
      : "open",
    createdAt,
    updatedAt,
    closedAt: fields["Microsoft.VSTS.Common.ClosedDate"] ?? null,
    description: fields["System.Description"] ?? "",
    commentCount: fields["System.CommentCount"] ?? 0,
    labels: (fields["System.Tags"] ?? "")
      .split(";")
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .map((name) => ({ name, color: null })),
    project: fields["System.TeamProject"]?.trim() || null,
    ...(item.relations == null ? {} : { relations: item.relations }),
  };
}

/**
 * A flat WIQL answer. Rows Azure returned but this cannot place are skipped rather than failing
 * the page: one work item type with a field this does not read is not a reason to show none.
 */
export function decodeWorkItemsJson(
  raw: string,
): Result.Result<{ readonly items: ReadonlyArray<AzureDevOpsWorkItem> }, DecodeFailure> {
  const rows = decodeUnknownList(raw.trim().length === 0 || raw.trim() === "null" ? "[]" : raw);
  if (!Result.isSuccess(rows)) return Result.fail(rows.failure);
  const items = rows.success.map(toWorkItem).filter((item) => item !== null);
  return Result.succeed({ items });
}

/** Null where az answered with a work item this cannot place, which the caller reports as such. */
export function decodeWorkItemJson(
  raw: string,
): Result.Result<AzureDevOpsWorkItem | null, DecodeFailure> {
  const decoded = decodeUnknownItem(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toWorkItem(decoded.success))
    : Result.fail(decoded.failure);
}

export function decodeWorkItemSummaryJson(
  raw: string,
): Result.Result<
  Pick<AzureDevOpsWorkItem, "number" | "title" | "url" | "state"> | null,
  DecodeFailure
> {
  const decoded = decodeJsonResult(WorkItem)(raw);
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
  const item = decoded.success;
  const number = typeof item.id === "string" ? Number(item.id) : item.id;
  const title = item.fields?.["System.Title"]?.trim();
  const url = browserUrl(item.url, number, item.fields?.["System.TeamProject"]);
  if (!Number.isInteger(number) || number <= 0 || !title || !url) return Result.succeed(null);
  return Result.succeed({
    number,
    title,
    url,
    state: CLOSED_STATES.has((item.fields?.["System.State"] ?? "").trim().toLowerCase())
      ? ("closed" as const)
      : ("open" as const),
  });
}

export const AZURE_DEVOPS_COMMENT_REACTIONS = {
  like: "thumbs-up",
  dislike: "thumbs-down",
  heart: "heart",
  hooray: "hooray",
  smile: "laugh",
  confused: "confused",
} as const satisfies Record<string, IssueReactionContent>;

const Comment = Schema.Struct({
  id: Schema.optional(Schema.Int),
  commentId: Schema.optional(Schema.Int),
  text: Schema.String,
  createdDate: Schema.String,
  createdBy: Schema.optional(Schema.NullOr(Identity)),
  isDeleted: Schema.optional(Schema.Boolean),
  reactions: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          type: Schema.Union([Schema.String, Schema.Int]),
          count: Schema.Int,
          isCurrentUserEngaged: Schema.optional(Schema.Boolean),
        }),
      ),
    ),
  ),
});

export function decodeWorkItemCommentsJson(raw: string): Result.Result<
  {
    readonly comments: ReadonlyArray<IssueComment>;
    readonly commentCount: number;
    readonly nextCursor: string | null;
  },
  DecodeFailure
> {
  const decoded = decodeJsonResult(
    Schema.Struct({
      comments: Schema.Array(Comment),
      totalCount: Schema.optional(Schema.Int),
      continuationToken: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  )(raw);
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
  const comments = decoded.success.comments.flatMap((entry): IssueComment[] => {
    const id = entry.id ?? entry.commentId;
    if (entry.isDeleted || id === undefined || id <= 0) return [];
    return [
      {
        id: String(id),
        author: actorOf(entry.createdBy),
        body: entry.text,
        createdAt: entry.createdDate,
        url: null,
        ...(entry.reactions === undefined
          ? {}
          : {
              reactions: (entry.reactions ?? []).flatMap((reaction) => {
                const type =
                  typeof reaction.type === "number"
                    ? Object.keys(AZURE_DEVOPS_COMMENT_REACTIONS)[reaction.type]
                    : reaction.type.toLowerCase();
                const content = Object.entries(AZURE_DEVOPS_COMMENT_REACTIONS).find(
                  ([native]) => native === type,
                )?.[1];
                return content === undefined || reaction.count <= 0
                  ? []
                  : [
                      {
                        content,
                        count: reaction.count,
                        actors: [],
                        viewerHasReacted: reaction.isCurrentUserEngaged ?? false,
                      },
                    ];
              }),
            }),
      },
    ];
  });
  return Result.succeed({
    comments,
    commentCount: decoded.success.totalCount ?? comments.length,
    nextCursor: decoded.success.continuationToken || null,
  });
}

const FieldChange = Schema.Struct({
  oldValue: Schema.optional(Schema.Unknown),
  newValue: Schema.optional(Schema.Unknown),
});

const isIsoDateTime = Schema.is(IsoDateTime);

const WorkItemUpdates = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({
      id: PositiveInt,
      rev: PositiveInt,
      revisedDate: IsoDateTime,
      revisedBy: Schema.optional(Schema.NullOr(Identity)),
      fields: Schema.optional(Schema.Record(Schema.String, FieldChange)),
      relations: Schema.optional(
        Schema.Struct({
          added: Schema.optional(Schema.Array(Relation)),
        }),
      ),
    }),
  ),
});

export const decodeWorkItemUpdatesJson = decodeJsonResult(WorkItemUpdates);
type WorkItemUpdate = (typeof WorkItemUpdates.Type.value)[number];

export function workItemUpdateEvents(update: WorkItemUpdate): ReadonlyArray<IssueEvent> {
  if (update.id === 1) return [];
  const fields = update.fields ?? {};
  const changedDate = fields["System.ChangedDate"]?.newValue;
  const createdAt = isIsoDateTime(changedDate) ? changedDate : update.revisedDate;
  if (createdAt.startsWith("9999-")) return [];
  const events: IssueEvent[] = [];
  const add = (kind: IssueEvent["kind"], detail: string | null) =>
    events.push({
      id: `azure-update-${update.id}-${events.length}`,
      kind,
      actor: actorOf(update.revisedBy),
      createdAt,
      detail,
    });
  const state = fields["System.State"];
  if (typeof state?.oldValue === "string" && typeof state.newValue === "string") {
    const wasClosed = CLOSED_STATES.has(state.oldValue.trim().toLowerCase());
    const isClosed = CLOSED_STATES.has(state.newValue.trim().toLowerCase());
    if (wasClosed !== isClosed)
      add(isClosed ? "closed" : "reopened", state.newValue.trim() || null);
  }
  const title = fields["System.Title"];
  if (
    typeof title?.oldValue === "string" &&
    typeof title.newValue === "string" &&
    title.oldValue !== title.newValue &&
    title.newValue.trim()
  )
    add("renamed", title.newValue.trim());
  const tags = fields["System.Tags"];
  if (tags) {
    const split = (value: unknown) =>
      typeof value === "string"
        ? [
            ...new Set(
              value
                .split(";")
                .map((tag) => tag.trim())
                .filter(Boolean),
            ),
          ]
        : [];
    const oldTags = split(tags.oldValue);
    const newTags = split(tags.newValue);
    for (const tag of oldTags) if (!newTags.includes(tag)) add("unlabeled", tag);
    for (const tag of newTags) if (!oldTags.includes(tag)) add("labeled", tag);
  }
  const assigned = fields["System.AssignedTo"];
  if (assigned) {
    const before = actorOf(assigned.oldValue)?.login;
    const after = actorOf(assigned.newValue)?.login;
    if (before?.toLowerCase() !== after?.toLowerCase()) {
      if (before) add("unassigned", before);
      if (after) add("assigned", after);
    }
  }
  for (const relation of update.relations?.added ?? []) {
    const pr = azureDevOpsPullRequestArtifact(relation);
    if (pr) add("referenced", `Pull request #${pr.number}`);
  }
  return events;
}

export const decodeLinkedPullRequestJson = decodeJsonResult(
  Schema.Struct({
    pullRequestId: PositiveInt,
    title: Schema.NonEmptyString,
    status: Schema.Literals(["active", "completed", "abandoned"]),
    url: Schema.optional(Schema.String),
    isDraft: Schema.optional(Schema.Boolean),
    repository: Schema.Struct({
      name: Schema.NonEmptyString,
      webUrl: Schema.optional(Schema.NullOr(Schema.String)),
      remoteUrl: Schema.optional(Schema.NullOr(Schema.String)),
      project: Schema.Struct({ name: Schema.NonEmptyString }),
    }),
  }),
);

export function azureDevOpsPullRequestArtifact(relation: typeof Relation.Type) {
  if (relation.rel !== "ArtifactLink" || !relation.url.startsWith("vstfs:///Git/PullRequestId/"))
    return null;
  try {
    const artifact = decodeURIComponent(relation.url.slice("vstfs:///Git/PullRequestId/".length));
    const match =
      /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/([1-9]\d*)$/iu.exec(
        artifact,
      );
    if (!match || Number(match[3]) > 2147483647) return null;
    return { project: match[1]!, repository: match[2]!, number: Number(match[3]) };
  } catch {
    return null;
  }
}
