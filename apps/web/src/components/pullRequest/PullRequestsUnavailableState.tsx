import { GitPullRequestIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";

export function PullRequestsUnavailableState({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) {
  return (
    <Empty className="px-4 py-16 md:px-4">
      <EmptyMedia variant="icon">
        <GitPullRequestIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>Could not load pull requests</EmptyTitle>
        {/* The server names the fix — install gh, sign in, use a GitHub project — so this
            shows its message rather than re-deriving one from the text. */}
        <EmptyDescription>{error}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCwIcon className="size-3.5" />
          Retry
        </Button>
      </EmptyContent>
    </Empty>
  );
}
