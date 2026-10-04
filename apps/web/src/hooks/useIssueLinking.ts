import { useMemo } from "react";
import {
  type EnvironmentId,
  type IssueRef,
  type ScopedThreadRef,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";

import { findLinkedIssue, parseIssueUrl } from "~/lib/issueReference";
import { findProjectForLink } from "~/lib/openIssueLink";
import { readThreadShell, useProjects, useServerConfigs } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  if (isAtomCommandInterrupted(result)) throw new Error("Link update interrupted.");
  throw squashAtomCommandFailure(result);
}

/** Links and unlinks issues on a thread, for the Link issue dialog and a link's context menu. */
export function useIssueLinking(environmentId: EnvironmentId | null | undefined) {
  const configs = useServerConfigs();
  const projects = useProjects();
  const supported =
    environmentId != null && configs.get(environmentId)?.environment.capabilities.issues === true;
  const readDetail = useAtomQueryRunner(issueEnvironment.detail, {
    reportFailure: false,
    reportDefect: false,
  });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  return useMemo(() => {
    const environmentProjects = projects.filter(
      (project) => project.environmentId === environmentId,
    );
    const linkedIssueFor = (threadRef: ScopedThreadRef, url: string) =>
      supported ? findLinkedIssue(readThreadShell(threadRef)?.issues ?? [], url) : null;
    /**
     * The issue a link in the conversation names, when a project here can read it. An issue in a
     * repository no project holds gets nothing: the server reads issues through their project.
     */
    const refForUrl = (url: string): IssueRef | null => {
      const parsed = supported ? parseIssueUrl(url) : null;
      const project = parsed === null ? undefined : findProjectForLink(environmentProjects, parsed);
      return parsed === null || project === undefined
        ? null
        : { projectId: project.id, repository: parsed.repository, number: parsed.number };
    };
    /** Reads the issue first, so the link carries the tracker's own URL, title and provider. */
    const link = async (threadRef: ScopedThreadRef, ref: IssueRef): Promise<ThreadIssueLink> => {
      const detail = unwrap(
        await readDetail({ environmentId: threadRef.environmentId, input: ref }),
      );
      // GitHub answers an issue read for a pull request number with the pull request.
      if (parseChangeRequestUrl(detail.url) !== null) {
        throw new Error(`${detail.repository}#${detail.number} is a pull request, not an issue.`);
      }
      const issue: ThreadIssueLink = {
        provider: detail.provider,
        repository: detail.repository,
        number: detail.number,
        url: detail.url,
        title: detail.title,
      };
      if (linkedIssueFor(threadRef, issue.url) !== null) {
        throw new Error(`${detail.repository}#${detail.number} is already linked.`);
      }
      unwrap(
        await updateMetadata({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, issueLink: issue },
        }),
      );
      return issue;
    };
    const unlink = async (threadRef: ScopedThreadRef, issue: ThreadIssueLink) => {
      unwrap(
        await updateMetadata({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            issueUnlink: {
              provider: issue.provider,
              repository: issue.repository,
              number: issue.number,
              url: issue.url,
            },
          },
        }),
      );
    };
    return { supported, projects: environmentProjects, linkedIssueFor, refForUrl, link, unlink };
  }, [environmentId, projects, readDetail, supported, updateMetadata]);
}
