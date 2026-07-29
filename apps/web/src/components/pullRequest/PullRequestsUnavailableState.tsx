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

/**
 * The three ways the feature can be switched off, told apart by the message the server sent
 * so the user is pointed at the fix rather than at a generic failure.
 */
function describeUnavailable(error: string): {
  readonly title: string;
  readonly description: string;
} {
  const normalized = error.toLowerCase();
  if (normalized.includes("not available on path")) {
    return {
      title: "GitHub CLI is not installed",
      description:
        "Install the GitHub CLI (`gh`) from https://cli.github.com/ and reload to browse pull requests.",
    };
  }
  if (normalized.includes("not authenticated")) {
    return {
      title: "GitHub CLI is not signed in",
      description: "Run `gh auth login` in a terminal, then retry.",
    };
  }
  return { title: "Could not load pull requests", description: error };
}

export function PullRequestsUnavailableState({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) {
  const { title, description } = describeUnavailable(error);
  return (
    <Empty className="py-16">
      <EmptyMedia variant="icon">
        <GitPullRequestIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
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
