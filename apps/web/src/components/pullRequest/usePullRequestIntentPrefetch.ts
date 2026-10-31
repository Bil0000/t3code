import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

const INTENT_DELAY_MS = 150;

interface PullRequestIntentTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

/**
 * Reads the detail a row's panel will ask for once the pointer or focus rests on it, so the
 * click paints from it. Passing over rows asks the host nothing, and leaving a row stops reading
 * it, so turn refreshes do not keep re-reading a row nobody opened.
 */
export function usePullRequestIntentPrefetch() {
  const [target, setTarget] = useState<PullRequestIntentTarget | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEnvironmentQuery(
    target === null
      ? null
      : pullRequestEnvironment.detail({
          environmentId: target.environmentId,
          input: {
            projectId: target.projectId,
            host: target.host.toLowerCase(),
            repository: target.repository,
            number: target.number,
            allowStale: false,
          },
        }),
  );
  return useStableCallback((next: PullRequestIntentTarget | null) => {
    clearTimeout(timer.current);
    if (next === null) {
      setTarget(null);
      return;
    }
    timer.current = setTimeout(() => setTarget(next), INTENT_DELAY_MS);
  });
}
