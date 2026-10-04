import {
  normalizeWorkItemLinkKey,
  sourceControlHostOf,
  type IssueRef,
  type ProjectId,
  type SourceControlProviderKind,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";

import { findProjectForIssue, findProjectForLink } from "./openIssueLink";

/**
 * The repository and number behind an issue URL, or null. GitLab's `/-/issues/` and
 * `/-/work_items/` are trusted anywhere. `/owner/repo/issues/N` is GitHub's shape (and
 * Bitbucket's), so it is read from any host too: callers only act on it once a project here
 * matches that host and repository, which is what keeps a lookalike URL inert.
 */
export function parseIssueUrl(
  targetUrl: string,
): { readonly repository: string; readonly number: number; readonly url: string } | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const match =
    /^\/((?:[\w.-]+\/)+[\w.-]+)\/-\/(?:issues|work_items)\/([1-9]\d*)\/?$/u.exec(url.pathname) ??
    /^\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)\/?$/u.exec(url.pathname);
  // A GitLab group's work items live under /groups/<group>/-/, which names no repository.
  if (!match?.[1] || !match[2] || match[1].startsWith("groups/")) return null;
  const number = Number(match[2]);
  return Number.isSafeInteger(number)
    ? { repository: match[1], number, url: targetUrl.trim() }
    : null;
}

/** host/repository#number, or null when the URL is not one parseIssueUrl reads. */
function issueKeyOf(url: string, repository?: string, number?: number): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return null;
  }
  const parsed = parseIssueUrl(url);
  const issue = parsed ?? (repository && number ? { repository, number } : null);
  return issue === null ? null : `${host}/${issue.repository.toLowerCase()}#${issue.number}`;
}

/**
 * The thread's link for the issue a URL names. The same issue reaches chat in more than one
 * spelling (GitLab's work_items path for an issues URL, a trailing slash, other casing), so links
 * are matched by host, repository and number; a URL nothing here parses (Linear, Azure DevOps)
 * still matches its own stored URL.
 */
export function findLinkedIssue<T extends ThreadIssueLink>(
  links: ReadonlyArray<T>,
  url: string,
): T | null {
  const key = issueKeyOf(url);
  const normalized = (provider: string) => normalizeWorkItemLinkKey({ provider, url }).url;
  return (
    links.find((link) =>
      key !== null
        ? issueKeyOf(link.url, link.repository, link.number) === key
        : normalizeWorkItemLinkKey(link).url === normalized(link.provider),
    ) ?? null
  );
}

/**
 * Which issue a typed reference names, or why it cannot. A URL may point at any repository a
 * project in this environment reads; `owner/repo#42` is read on the thread project's host and a
 * bare `#42` through the thread's own project. The server reads an issue only through the project
 * that holds its repository, so a repository no project holds is refused here, not after a read.
 */
export function resolveIssueReference(input: {
  readonly reference: string;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly projectId: ProjectId | null;
}): { readonly ref: IssueRef } | { readonly error: string } | null {
  const reference = input.reference.trim();
  if (/^https?:\/\//iu.test(reference)) {
    const parsed = parseIssueUrl(reference);
    if (parsed === null) return null;
    const project = findProjectForLink(input.projects, parsed);
    if (project === undefined) {
      return { error: `No project in this environment can read ${parsed.repository}.` };
    }
    return {
      ref: { projectId: project.id, repository: parsed.repository, number: parsed.number },
    };
  }
  const match = /^(?:([\w.-]+(?:\/[\w.-]+)+))?#?([1-9]\d*)$/u.exec(reference);
  if (!match?.[2] || (match[1] !== undefined && !reference.includes("#"))) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) return null;
  const threadProject = input.projects.find((candidate) => candidate.id === input.projectId);
  const identity = threadProject?.repositoryIdentity;
  const ownRepository = sourceControlRepositorySelector(identity) ?? null;
  if (threadProject === undefined || !identity || ownRepository === null) {
    return { error: "Paste a full issue URL; this thread's project has no repository." };
  }
  if (match[1] === undefined) {
    return { ref: { projectId: threadProject.id, repository: ownRepository, number } };
  }
  const kind = identity.provider as SourceControlProviderKind;
  const project = findProjectForIssue(input.projects, {
    host: sourceControlHostOf(identity, kind),
    repository: match[1],
  });
  if (project === undefined) {
    return { error: `No project in this environment can read ${match[1]}.` };
  }
  return { ref: { projectId: project.id, repository: match[1], number } };
}
