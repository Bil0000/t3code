import { changeRequestUrlFor as changeRequestWebUrl } from "@t3tools/shared/changeRequestUrl";
export { changeRequestUrlFor as changeRequestWebUrl } from "@t3tools/shared/changeRequestUrl";
import {
  pullRequestHostOf,
  type RepositoryIdentity,
  type SourceControlProviderKind,
} from "@t3tools/contracts";

import { parseChangeRequestUrl } from "~/lib/openPullRequestLink";
import { parsePullRequestReference } from "~/pullRequestReference";

/** Where a bare pull request number in a project points: its host, repository and web URL. */
export function pullRequestProjectOf(identity: RepositoryIdentity | null | undefined): {
  readonly host: string;
  readonly repository: string;
  readonly webUrl: (number: number) => string | null;
} | null {
  if (!identity) return null;
  const repository =
    identity.displayName ??
    (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
  if (repository === null) return null;
  const kind = identity.provider as SourceControlProviderKind;
  const host = pullRequestHostOf(identity, kind);
  return {
    host,
    repository,
    webUrl: (number: number) =>
      kind === "forgejo" && identity.webUrl
        ? `${identity.webUrl.replace(/\/+$/, "")}/pulls/${number}`
        : changeRequestWebUrl(kind, host, repository, number, identity.locator.remoteUrl),
  };
}

interface ResolvedLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

/**
 * Which pull request an input names, or why it cannot. A URL carries its own host and
 * repository and may point at any repository on a host this environment has a project for; a
 * bare `#123` can only mean the thread's own repository.
 */
export function resolveLinkPullRequestInput(input: {
  readonly reference: string;
  readonly project: {
    readonly host: string;
    readonly repository: string;
    readonly webUrl: (number: number) => string | null;
  } | null;
  readonly hasProject: (reference: ResolvedLink) => boolean;
}): { link: ResolvedLink } | { error: string } | null {
  const parsed =
    parseChangeRequestUrl(input.reference.trim()) !== null
      ? input.reference.trim()
      : parsePullRequestReference(input.reference);
  if (parsed === null) return null;
  const url = parseChangeRequestUrl(parsed);
  if (url !== null) {
    if (!input.hasProject({ ...url, url: parsed })) {
      return { error: `No project in this environment can read ${url.host}/${url.repository}.` };
    }
    return {
      link: { host: url.host, repository: url.repository, number: url.number, url: parsed },
    };
  }
  const number = Number(parsed);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  if (input.project === null) {
    return { error: "Paste a full URL to link a pull request from another repository." };
  }
  const webUrl = input.project.webUrl(number);
  const webReference = webUrl === null ? null : parseChangeRequestUrl(webUrl);
  if (webUrl === null || webReference === null) {
    return { error: "Paste a full URL; this project's host has no known pull request URL." };
  }
  return {
    link: { ...webReference, url: webUrl },
  };
}
