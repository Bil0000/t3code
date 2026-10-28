import type {
  PullRequestComment,
  PullRequestDetail,
  PullRequestReviewThread,
} from "@t3tools/contracts";

type EditingSubject = Pick<
  PullRequestDetail,
  "author" | "capabilities" | "viewer" | "viewerPermissions"
>;

function sameLogin(one: string | null | undefined, other: string | null | undefined): boolean {
  if (one == null || other == null) return false;
  return one.trim().toLowerCase() === other.trim().toLowerCase();
}

export function canEditPullRequestChangeRequest(detail: EditingSubject): boolean {
  if (detail.capabilities.edit?.changeRequest !== true) return false;
  if (detail.viewerPermissions.editChangeRequest !== undefined) {
    return detail.viewerPermissions.editChangeRequest;
  }
  return (
    sameLogin(detail.viewer, detail.author?.login) ||
    detail.viewerPermissions.actions.includes("merge")
  );
}

export function canEditPullRequestMaintainerEdits(
  detail: Pick<
    PullRequestDetail,
    "state" | "capabilities" | "viewerPermissions" | "maintainerCanModify"
  >,
): boolean {
  return (
    detail.state === "open" &&
    detail.capabilities.edit?.maintainerEdits === true &&
    detail.viewerPermissions.maintainerEdits === true &&
    detail.maintainerCanModify !== undefined
  );
}

export interface MaintainerEditsChoice {
  readonly key: string;
  readonly observed: boolean | undefined;
  readonly value: boolean;
}

/** A choice ends at the first host value that differs from the one it was made against. */
export function maintainerEditsChoiceInForce(
  choice: MaintainerEditsChoice | null,
  key: string,
  observed: boolean | undefined,
  saving: boolean,
): MaintainerEditsChoice | null {
  if (choice === null || choice.key !== key) return null;
  return saving || choice.observed === observed ? choice : null;
}

/** Hosts do not support rewriting review summaries through comment mutations. */
export function canEditPullRequestComment(
  detail: EditingSubject,
  comment: Pick<PullRequestComment, "author" | "canEdit" | "kind">,
): boolean {
  if (detail.capabilities.edit?.comment !== true) return false;
  if (comment.kind !== "issue-comment" && comment.kind !== "review-comment") return false;
  if (comment.canEdit !== undefined) return comment.canEdit;
  return sameLogin(detail.viewer, comment.author?.login);
}

export function canResolvePullRequestThread(
  detail: Pick<PullRequestDetail, "viewerPermissions">,
  thread: Pick<PullRequestReviewThread, "canResolve">,
): boolean {
  return detail.viewerPermissions.resolve && thread.canResolve !== false;
}
