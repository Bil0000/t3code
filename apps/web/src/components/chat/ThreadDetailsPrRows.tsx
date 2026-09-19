import type { EnvironmentId, ThreadPullRequestLink } from "@t3tools/contracts";
import {
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { MinusIcon, PlusIcon } from "lucide-react";
import { useState, type ComponentProps, type MouseEvent as ReactMouseEvent } from "react";

import { findProjectOnChangeRequestHost, parseChangeRequestUrl } from "~/lib/openPullRequestLink";
import { useProjects } from "~/state/entities";

import { pullRequestListLines } from "../pullRequest/pullRequestListLines";
import { linkedPullRequestSnapshotStatus, prStatusIndicator } from "../ThreadStatusIndicators";
import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";

function ThreadDetailsPrLinkRow({
  environmentId,
  link,
  onOpen,
  onActed,
}: {
  environmentId: EnvironmentId;
  link: ThreadPullRequestLink;
  onOpen: (event: ReactMouseEvent<HTMLElement>) => void;
  onActed?: (() => void) | undefined;
}) {
  const projects = useProjects();
  const parsed = parseChangeRequestUrl(link.url);
  const project =
    parsed === null
      ? null
      : (findProjectOnChangeRequestHost(
          projects.filter((candidate) => candidate.environmentId === environmentId),
          parsed,
        ) ?? null);
  const linked = linkedPullRequestSnapshotStatus(link);
  const pr = linked?.pr ?? null;
  return (
    <ThreadDetailsPrRow
      environmentId={environmentId}
      pr={pr}
      number={link.number}
      reference={link}
      status={prStatusIndicator(pr, linked?.sourceControlProvider)}
      project={project}
      label={`#${link.number}${link.snapshot === null ? "" : `: ${link.snapshot.title}`}`}
      openAriaLabel={link.url}
      onOpen={onOpen}
      {...(onActed ? { onActed } : {})}
    />
  );
}

export function ThreadDetailsPrRows({
  links,
  currentLink,
  onOpenLink,
  ...row
}: ComponentProps<typeof ThreadDetailsPrRow> & {
  links: ReadonlyArray<ThreadPullRequestLink>;
  currentLink: ThreadPullRequestLink | null;
  onOpenLink: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const rest =
    currentLink === null
      ? []
      : pullRequestListLines(resolveThreadPullRequestChains(visibleThreadPullRequests(links)))
          .map((line) => line.link)
          .filter((link) => threadPullRequestKeyOf(link) !== threadPullRequestKeyOf(currentLink));
  if (rest.length === 0) return <ThreadDetailsPrRow {...row} />;

  return (
    <>
      <ThreadDetailsPrRow {...row} />
      {expanded
        ? rest.map((link) => (
            <ThreadDetailsPrLinkRow
              key={threadPullRequestKeyOf(link)}
              environmentId={row.environmentId}
              link={link}
              onOpen={(event) => onOpenLink(event, link.url)}
              onActed={row.onActed}
            />
          ))
        : null}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg border border-transparent px-2.5 text-left text-[13px] font-medium text-muted-foreground/70 hover:bg-black/[0.055] hover:text-foreground/80 dark:hover:bg-white/[0.075]"
      >
        {expanded ? (
          <MinusIcon aria-hidden className="-mx-0.5 size-4 shrink-0" />
        ) : (
          <PlusIcon aria-hidden className="-mx-0.5 size-4 shrink-0" />
        )}
        {expanded ? "Show less" : `Show ${rest.length} more`}
      </button>
    </>
  );
}
