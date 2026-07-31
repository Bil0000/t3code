/**
 * A review being written, held until it is sent.
 *
 * Nothing here reaches the host: a review is one request carrying every line comment and the
 * verdict together, so a half-written one is invisible to everyone else — including on the
 * hosts that have no pending review of their own. That also means a draft lives only as long
 * as the tab does, which is why this is deliberately not persisted.
 */
import type { ProjectId, PullRequestDiffSide, PullRequestRef } from "@t3tools/contracts";
import { create } from "zustand";

export interface PendingReviewComment {
  readonly id: string;
  readonly path: string;
  /** The line in the file the comment's side names: the new file on the right, the old on the left. */
  readonly line: number;
  readonly side: PullRequestDiffSide;
  readonly body: string;
}

/** One pull request's draft, scoped by project as well as repository: a repository can be checked out twice. */
export function pullRequestReviewKey(reference: PullRequestRef): string {
  return `${reference.projectId}/${reference.repository}#${reference.number}`;
}

interface PullRequestReviewStoreState {
  readonly drafts: Readonly<Record<string, ReadonlyArray<PendingReviewComment>>>;
  readonly addComment: (key: string, comment: PendingReviewComment) => void;
  readonly removeComment: (key: string, commentId: string) => void;
  readonly clear: (key: string) => void;
}

const EMPTY: ReadonlyArray<PendingReviewComment> = [];

export const usePullRequestReviewStore = create<PullRequestReviewStoreState>()((set) => ({
  drafts: {},
  addComment: (key, comment) =>
    set((state) => ({
      drafts: { ...state.drafts, [key]: [...(state.drafts[key] ?? EMPTY), comment] },
    })),
  removeComment: (key, commentId) =>
    set((state) => {
      const remaining = (state.drafts[key] ?? EMPTY).filter((entry) => entry.id !== commentId);
      if (remaining.length > 0) return { drafts: { ...state.drafts, [key]: remaining } };
      const { [key]: _removed, ...rest } = state.drafts;
      return { drafts: rest };
    }),
  clear: (key) =>
    set((state) => {
      const { [key]: _removed, ...rest } = state.drafts;
      return { drafts: rest };
    }),
}));

/** The comments a pull request's draft holds, stable across renders while it is empty. */
export function usePendingReviewComments(reference: {
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
}): ReadonlyArray<PendingReviewComment> {
  return usePullRequestReviewStore(
    (store) => store.drafts[pullRequestReviewKey(reference)] ?? EMPTY,
  );
}
