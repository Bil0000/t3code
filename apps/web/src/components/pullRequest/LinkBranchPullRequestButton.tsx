import type { ScopedThreadRef } from "@t3tools/contracts";
import { Link2 } from "lucide-react";
import { useState } from "react";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { openLinkPullRequestDialog } from "./LinkPullRequestDialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function LinkBranchPullRequestButton({
  threadRef,
  url,
  linked,
}: {
  threadRef: ScopedThreadRef;
  url: string;
  linked: boolean;
}) {
  const linking = usePullRequestLinking(threadRef.environmentId);
  const [pending, setPending] = useState(false);
  if (linked ? linking.mode !== "multiple" : !linking.canLink(url)) return null;
  const label = linked ? "Link another PR" : "Link this PR";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-tiny"
            variant="ghost-muted"
            aria-label={label}
            disabled={pending}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={async (event) => {
              event.preventDefault();
              event.stopPropagation();
              if (linked) {
                openLinkPullRequestDialog(threadRef);
                return;
              }
              setPending(true);
              try {
                await linking.changeLink(threadRef, url, true);
              } catch (error) {
                toastManager.add({
                  type: "error",
                  title: "Could not link pull request",
                  description: error instanceof Error ? error.message : String(error),
                });
              } finally {
                setPending(false);
              }
            }}
          >
            <Link2 className="size-3" />
          </Button>
        }
      />
      <TooltipPopup>{linked ? label : "Link this PR to keep it with this thread"}</TooltipPopup>
    </Tooltip>
  );
}
