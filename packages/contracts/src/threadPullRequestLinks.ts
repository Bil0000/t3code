import type { ThreadLinkedPullRequest, ThreadPullRequestLink } from "./orchestration.ts";

interface ThreadPullRequestState {
  readonly pullRequestLinks?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  readonly branchPullRequest?: ThreadLinkedPullRequest | null | undefined;
}

export function sameThreadPullRequest(
  left: ThreadLinkedPullRequest,
  right: ThreadLinkedPullRequest,
) {
  return (
    left.projectId === right.projectId &&
    left.repository.toLowerCase() === right.repository.toLowerCase() &&
    left.number === right.number
  );
}

export function getThreadPullRequestLinks(
  thread: ThreadPullRequestState,
): ReadonlyArray<ThreadPullRequestLink> {
  return (
    thread.pullRequestLinks ?? [
      ...(thread.linkedPullRequest
        ? [{ ...thread.linkedPullRequest, source: "linked" as const }]
        : []),
      ...(thread.branchPullRequest
        ? [{ ...thread.branchPullRequest, source: "branch" as const }]
        : []),
    ]
  );
}

export function getThreadPullRequest(thread: ThreadPullRequestState | null | undefined) {
  if (thread == null) return null;
  const links = getThreadPullRequestLinks(thread);
  return links.find((link) => link.source === "linked") ?? links[0] ?? null;
}

export function threadPullRequestFields(links: ReadonlyArray<ThreadPullRequestLink>) {
  const reference = (source: ThreadPullRequestLink["source"]) => {
    const link = links.find((link) => link.source === source);
    return link
      ? {
          projectId: link.projectId,
          repository: link.repository,
          number: link.number,
          url: link.url,
        }
      : null;
  };
  return {
    pullRequestLinks: links,
    linkedPullRequest: reference("linked"),
    branchPullRequest: reference("branch"),
  };
}

export function applyThreadPullRequestUpdate(
  thread: ThreadPullRequestState,
  update: ThreadPullRequestState,
) {
  if (update.pullRequestLinks !== undefined)
    return threadPullRequestFields(update.pullRequestLinks);
  if (update.linkedPullRequest === undefined && update.branchPullRequest === undefined) return {};
  let links = getThreadPullRequestLinks(thread);
  for (const [source, reference] of [
    ["linked", update.linkedPullRequest],
    ["branch", update.branchPullRequest],
  ] as const) {
    if (reference === undefined) continue;
    links = links.filter((link) => link.source !== source);
    if (reference !== null) links = [...links, { ...reference, source }];
  }
  return threadPullRequestFields(links);
}
