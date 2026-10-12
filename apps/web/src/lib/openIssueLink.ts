import {
  sourceControlHostOf,
  type IssueRef,
  type ProjectId,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { parseIssueUrl } from "@t3tools/shared/issueUrl";
import { canonicalRepositoryKey } from "@t3tools/shared/sourceControl";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { IssueTarget } from "../rightPanelStore";

/**
 * The project an issue link belongs to, or nothing. Matched the way the server matches: the
 * repository identity is the full path below the host where one was recorded — which is what
 * nested GitLab groups need — and the host is the first segment of the canonical remote, so
 * github.com and an Enterprise install stay apart.
 *
 * An Azure DevOps work item names only its team project, not a repository below it, so its link
 * alone also matches a repository identity that merely starts with that project's path: the work
 * item is the same one whichever repository under the project opens it. Every other host writes
 * the whole repository path into the link, so there the match is exact — a nested GitLab project
 * is a different repository from the group above it, not the same one seen from further down.
 */
export function findProjectForIssue(
  projects: ReadonlyArray<EnvironmentProject>,
  link: { readonly host: string; readonly repository: string },
): EnvironmentProject | undefined {
  return projects.find((project) => {
    const identity = project.repositoryIdentity;
    if (!identity) return false;
    const kind = identity.provider as SourceControlProviderKind | undefined;
    if (kind === undefined) return false;
    if (kind === "azure-devops") {
      const checkout = `${canonicalRepositoryKey(identity.canonicalKey.toLowerCase())}/`;
      const linkKey = `${link.host}/${link.repository}`.toLowerCase();
      return [
        canonicalRepositoryKey(linkKey),
        canonicalRepositoryKey(`${linkKey}/_git/_`).slice(0, -"/_git/_".length),
      ].some((prefix) => checkout.startsWith(`${prefix}/`));
    }
    const repository =
      identity.displayName ??
      (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
    if (repository === null || sourceControlHostOf(identity, kind) !== link.host.toLowerCase()) {
      return false;
    }
    return repository.toLowerCase() === link.repository.toLowerCase();
  });
}

export function repositoryForProjectLink(project: EnvironmentProject, fallback: string): string {
  return project.repositoryIdentity?.displayName ?? fallback;
}

export function linkedPullRequestTarget(
  project: EnvironmentProject,
  link: { readonly repository: string; readonly number: number; readonly url: string },
) {
  const parsed = parseChangeRequestUrl(link.url);
  return {
    projectId: project.id,
    ...(parsed === null ? {} : { host: parsed.authority ?? parsed.host }),
    repository: repositoryForProjectLink(project, link.repository),
    number: link.number,
  };
}

/**
 * The project a linked issue or change request belongs to, or nothing. A link carries the
 * repository it was filed in, which need not be the one on screen — a cross-repository reference
 * keeps its own — so the project is resolved from that repository rather than assumed from the
 * open surface: pairing one repository with another project's id makes a reference the server
 * refuses to read.
 *
 * The host comes from the link's own URL, because a repository path alone cannot tell two hosts
 * apart. A host nothing here is checked out from matches no project, and the caller falls back to
 * the browser, exactly as it would for a lookalike.
 */
export function findProjectForLink(
  projects: ReadonlyArray<EnvironmentProject>,
  link: { readonly repository: string; readonly number: number; readonly url: string },
): EnvironmentProject | undefined {
  let host: string;
  try {
    host = new URL(link.url).host.toLowerCase();
  } catch {
    return undefined;
  }
  return findProjectForIssue(projects, { host, repository: link.repository });
}

export function parseKnownIssueUrl(projects: ReadonlyArray<EnvironmentProject>, raw: string) {
  const parsed = parseIssueUrl(raw);
  if (parsed !== null || !URL.canParse(raw)) return parsed;
  const host = new URL(raw).host.toLowerCase();
  const provider = projects
    .map((project) => project.repositoryIdentity)
    .find((identity) => {
      const kind = identity?.provider as SourceControlProviderKind | undefined;
      return (
        kind !== undefined && kind !== "unknown" && sourceControlHostOf(identity, kind) === host
      );
    })?.provider;
  return provider === undefined ? null : parseIssueUrl(raw, { provider });
}

export function issueLinkTarget(
  projects: ReadonlyArray<EnvironmentProject>,
  link: {
    readonly provider?: string | undefined;
    readonly repository?: string | undefined;
    readonly number: number;
    readonly url: string;
  },
  fallbackProjectId: string | null,
): IssueTarget | null {
  const parsed = parseKnownIssueUrl(projects, link.url);
  const url =
    parsed === null ||
    parsed.number !== link.number ||
    (link.provider !== undefined && parsed.provider !== link.provider)
      ? null
      : parsed;
  const repository = link.repository ?? url?.repository;
  const project =
    repository === undefined ? undefined : findProjectForLink(projects, { ...link, repository });
  const provider = url?.provider ?? link.provider;
  const projectId = project?.id ?? (url === null ? null : fallbackProjectId);
  if (projectId === null || repository === undefined) return null;
  return {
    projectId,
    ...(provider === undefined ? {} : { provider }),
    ...(url === null ? {} : { host: new URL(url.url).host, url: url.url }),
    repository:
      project === undefined
        ? (url?.repository ?? repository)
        : repositoryForProjectLink(project, repository),
    number: link.number,
  };
}

export function issueRefOf(target: IssueTarget): IssueRef {
  return {
    projectId: target.projectId as ProjectId,
    ...(target.provider === undefined ? {} : { provider: target.provider }),
    ...(target.host === undefined ? {} : { host: target.host }),
    ...(target.url === undefined ? {} : { url: target.url }),
    repository: target.repository,
    number: target.number,
  };
}

export function relatedIssueTarget(
  projects: ReadonlyArray<EnvironmentProject>,
  current: {
    readonly projectId: string;
    readonly host?: string;
    readonly repository: string;
    readonly url?: string;
  },
  relative: {
    readonly repository?: string | undefined;
    readonly number: number;
    readonly url: string;
  },
): IssueTarget | null {
  const same =
    relative.repository === undefined ||
    relative.repository.toLowerCase() === current.repository.toLowerCase();
  if (same && current.url === undefined) {
    return {
      projectId: current.projectId,
      ...(current.host === undefined ? {} : { host: current.host }),
      repository: current.repository,
      number: relative.number,
    };
  }
  return issueLinkTarget(
    projects,
    same ? { number: relative.number, url: relative.url } : relative,
    current.projectId,
  );
}

/**
 * Hands a link to the system browser, which is where one this workspace cannot place belongs, and
 * says so when the desktop bridge is missing rather than swallowing the press.
 */
export function openLinkInBrowser(targetUrl: string): void {
  const api = readLocalApi();
  if (!api) {
    toastManager.add({
      type: "error",
      title: "Link opening is unavailable.",
    });
    return;
  }

  const protocol = URL.canParse(targetUrl) ? new URL(targetUrl).protocol : null;
  const opened =
    protocol === "https:" || protocol === "http:"
      ? api.shell.openExternal(targetUrl)
      : Promise.reject(new Error("Issue links must use HTTP or HTTPS."));
  void opened.catch((error) => {
    console.error(error);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open issue link",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  });
}
