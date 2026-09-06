import {
  getThreadPullRequestLinks,
  type ScopedThreadRef,
  type ThreadLinkedPullRequest,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { GitPullRequestIcon } from "lucide-react";
import { useThreadShell, useServerConfigs } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
} from "../ui/menu";
import { toastManager } from "../ui/toast";

export function ThreadPullRequestMenu({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const supportsLinks =
    useServerConfigs().get(threadRef.environmentId)?.environment.capabilities
      .threadPullRequestLinks === true;
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const links =
    thread === null
      ? []
      : getThreadPullRequestLinks(thread).filter((link) => link.source === "linked");
  if (links.length === 0) return null;

  const updateLink = async (action: "link" | "unlink", pullRequest: ThreadLinkedPullRequest) => {
    const result = await updateMetadata({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, pullRequestLink: { action, pullRequest } },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Failed to update PR link",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    }
  };

  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="sm" aria-label="Linked pull requests" />}>
        <GitPullRequestIcon className="size-3.5" />
        {links.length} PR{links.length === 1 ? "" : "s"}
      </MenuTrigger>
      <MenuPopup align="end">
        {links.map((link, index) => (
          <MenuGroup key={`${link.projectId}:${link.repository}:${link.number}`}>
            {index > 0 && <MenuSeparator />}
            <MenuGroupLabel>
              {link.repository} #{link.number}
              {index === 0 ? " · Primary" : ""}
            </MenuGroupLabel>
            <MenuItem
              onClick={() => useRightPanelStore.getState().openPullRequest(threadRef, link)}
            >
              Open pull request
            </MenuItem>
            {supportsLinks && index > 0 && (
              <MenuItem onClick={() => void updateLink("link", link)}>Use as primary</MenuItem>
            )}
            {supportsLinks && (
              <MenuItem onClick={() => void updateLink("unlink", link)}>
                Unlink from thread
              </MenuItem>
            )}
          </MenuGroup>
        ))}
      </MenuPopup>
    </Menu>
  );
}
