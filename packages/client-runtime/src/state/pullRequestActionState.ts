import type { PullRequestAction, PullRequestState } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

export interface PullRequestActionState {
  readonly pendingAction: PullRequestAction | null;
  readonly mergeHold: boolean;
  readonly observedPostMergeRead: boolean;
}

export const EMPTY_PULL_REQUEST_ACTION_STATE = Object.freeze<PullRequestActionState>({
  pendingAction: null,
  mergeHold: false,
  observedPostMergeRead: false,
});

export const pullRequestActionStateAtom = Atom.family((pullRequestKey: string) =>
  Atom.make(EMPTY_PULL_REQUEST_ACTION_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`pull-request-action:${pullRequestKey}`),
  ),
);

export function beginPullRequestAction(
  state: PullRequestActionState,
  action: PullRequestAction,
): PullRequestActionState {
  if (state.pendingAction !== null) return state;
  return { ...state, pendingAction: action };
}

export function completePullRequestAction(
  state: PullRequestActionState,
  action: PullRequestAction,
): PullRequestActionState {
  if (action !== "merge") return { ...state, pendingAction: null };
  return {
    pendingAction: null,
    mergeHold: true,
    observedPostMergeRead: false,
  };
}

export function failPullRequestAction(state: PullRequestActionState): PullRequestActionState {
  if (state.pendingAction === null) return state;
  return { ...state, pendingAction: null };
}

function clearMergeHold(state: PullRequestActionState): PullRequestActionState {
  if (state.pendingAction === null) return EMPTY_PULL_REQUEST_ACTION_STATE;
  return { ...state, mergeHold: false, observedPostMergeRead: false };
}

export function observePullRequestDetail(
  state: PullRequestActionState,
  detail: {
    readonly state: PullRequestState | null;
    readonly isPending: boolean;
  },
): PullRequestActionState {
  if (!state.mergeHold) return state;
  if (detail.state !== null && detail.state !== "open") {
    return clearMergeHold(state);
  }
  if (detail.isPending) {
    return state.observedPostMergeRead ? state : { ...state, observedPostMergeRead: true };
  }
  // The settled detail already on screen predates the merge unless a pending read was observed.
  return state.observedPostMergeRead ? clearMergeHold(state) : state;
}
