import { IssueUnavailableError } from "@t3tools/contracts";
import { CircleDotIcon } from "lucide-react";

import { UnavailableState } from "../sourceControl/UnavailableState";

const TRACKER_RETIRED = new IssueUnavailableError({ reason: "tracker-retired" }).message;

export function IssuesUnavailableState({
  title = "Could not load issues",
  error,
  onRetry,
  refreshing = false,
}: {
  title?: string;
  error: string;
  onRetry?: () => void;
  refreshing?: boolean;
}) {
  if (error === TRACKER_RETIRED) {
    return (
      <UnavailableState
        icon={<CircleDotIcon />}
        title="Issues are no longer available"
        error={`${error} Its repositories and pull requests still work here.`}
      />
    );
  }
  return (
    <UnavailableState
      icon={<CircleDotIcon />}
      title={title}
      error={error}
      onRetry={onRetry}
      refreshing={refreshing}
    />
  );
}
