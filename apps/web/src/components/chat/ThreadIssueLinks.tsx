import type { ScopedThreadRef } from "@t3tools/contracts";
import { CircleDotIcon, UnlinkIcon } from "lucide-react";
import { useState } from "react";
import { useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useRightPanelStore } from "~/rightPanelStore";
import { IssueStateGlyph } from "../issue/issuePresentation";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

export function ThreadIssueLinks({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const update = useAtomCommand(threadEnvironment.updateMetadata);
  const [pending, setPending] = useState(false);
  const issues = thread?.issues ?? [];
  if (!thread || issues.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger render={<Button size="xs" variant="ghost" />} aria-label="Linked issues">
        <CircleDotIcon aria-hidden className="size-3.5" />
        {issues.length}
      </PopoverTrigger>
      <PopoverPopup align="end" width="md">
        <PopoverTitle className="mb-2">Linked issues</PopoverTitle>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {issues.map((issue) => (
            <div key={issue.url} className="flex items-center gap-1">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-start gap-1.5 rounded-sm px-1 py-1 text-left text-xs hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() =>
                  useRightPanelStore.getState().openIssue(threadRef, {
                    projectId: thread.projectId,
                    provider: issue.provider,
                    repository: issue.repository,
                    number: issue.number,
                  })
                }
              >
                {issue.state === undefined ? null : (
                  <IssueStateGlyph
                    state={issue.state}
                    stateReason={issue.stateReason ?? null}
                    className="mt-0.5 size-3.5"
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{issue.title}</span>
                  <span className="text-muted-foreground">
                    {issue.repository} · {issue.number}
                  </span>
                </span>
              </button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Unlink ${issue.title}`}
                disabled={pending}
                onClick={async () => {
                  setPending(true);
                  try {
                    await update({
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
                    });
                  } finally {
                    setPending(false);
                  }
                }}
              >
                <UnlinkIcon aria-hidden className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
