import type { EnvironmentId, IssueCapabilities, IssueReaction, IssueRef } from "@t3tools/contracts";

import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";

import { SourceControlReactionBar } from "../sourceControl/SourceControlReactions";

export function IssueReactionBar({
  reactions,
  capabilities,
  subjectId,
  environmentId,
  reference,
  onRefresh,
  className,
}: {
  readonly reactions: ReadonlyArray<IssueReaction>;
  readonly capabilities: IssueCapabilities;
  readonly subjectId?: string | undefined;
  readonly environmentId: EnvironmentId;
  readonly reference: IssueRef;
  readonly onRefresh: () => void;
  readonly className?: string | undefined;
}) {
  const setReaction = useAtomCommand(issueEnvironment.setReaction, { reportFailure: false });
  return (
    <SourceControlReactionBar
      reactions={reactions}
      canReact={
        (subjectId === undefined
          ? capabilities.reactions
          : (capabilities.commentReactions ?? capabilities.reactions)) === true
      }
      contents={capabilities.reactionContents}
      className={className}
      onToggle={async (content, reacted) => {
        const result = await setReaction({
          environmentId,
          input: {
            ...reference,
            ...(subjectId === undefined ? {} : { subjectId }),
            content,
            reacted,
          },
        });
        if (result._tag === "Failure") return false;
        onRefresh();
        return true;
      }}
    />
  );
}
