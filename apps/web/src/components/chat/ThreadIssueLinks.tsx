import type { ScopedThreadRef, ThreadIssueLink } from "@t3tools/contracts";
import { ArrowUpRightIcon, CircleDotIcon, LinkIcon, UnlinkIcon } from "lucide-react";
import { useOpenLink } from "~/browser/useOpenLink";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useIssueLinking } from "~/hooks/useIssueLinking";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { useRightPanelStore } from "~/rightPanelStore";
import { LinkedItemRowActions, LinkedItemRowLines, LINKED_ITEM_ROW_CLASS } from "../LinkedItemRow";
import { Button } from "../ui/button";
import { MenuItem } from "../ui/menu";
import { toastManager } from "../ui/toast";

/** The header's count of linked issues; opens the Linked items tab, where they are listed. */
export function ThreadIssueLinks({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const count = thread?.issues?.length ?? 0;
  if (count === 0) return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      aria-label="Linked issues"
      onClick={() => useRightPanelStore.getState().open(threadRef, "pull-requests")}
    >
      <CircleDotIcon aria-hidden className="size-3.5" />
      {count}
    </Button>
  );
}

/** The thread's linked issues as rows of the Linked items tab: open one, or unlink it. */
export function ThreadIssueRows({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const issueLinking = useIssueLinking(threadRef.environmentId);
  const openLink = useOpenLink(threadRef);
  const issues = thread?.issues ?? [];
  if (!thread || issues.length === 0) return null;

  const unlink = async (issue: ThreadIssueLink) => {
    try {
      await issueLinking.unlink(threadRef, issue);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to unlink issue",
        description: error instanceof Error ? error.message : "The request failed.",
      });
    }
  };

  return issues.map((issue) => (
    <div key={issue.url} className={cn(LINKED_ITEM_ROW_CLASS, "pl-2")}>
      <CircleDotIcon aria-hidden className="mt-4.5 size-4 shrink-0 text-muted-foreground" />
      <button
        type="button"
        className="flex min-w-0 flex-1 text-left"
        onClick={() =>
          useRightPanelStore.getState().openIssue(threadRef, {
            projectId: thread.projectId,
            provider: issue.provider,
            repository: issue.repository,
            number: issue.number,
          })
        }
      >
        <LinkedItemRowLines
          reference={`${issue.repository}#${issue.number}`}
          referenceTooltip={issue.url}
          title={issue.title}
        />
      </button>
      <LinkedItemRowActions label={`Actions for ${issue.repository}#${issue.number}`}>
        <MenuItem onClick={() => void writeTextToClipboard(issue.url, "link")}>
          <LinkIcon className="size-3.5" />
          Copy link
        </MenuItem>
        <MenuItem onClick={(event) => void openLink(issue.url, { event })}>
          <ArrowUpRightIcon className="size-3.5" />
          Open
        </MenuItem>
        <MenuItem onClick={() => void unlink(issue)}>
          <UnlinkIcon className="size-3.5" />
          Unlink from thread
        </MenuItem>
      </LinkedItemRowActions>
    </div>
  ));
}
