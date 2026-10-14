import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { toastManager } from "../ui/toast";

export function reportIssueResult<A, E>(result: AtomCommandResult<A, E>, title: string): boolean {
  if (result._tag === "Success") return true;
  toastManager.add({
    type: "error",
    title,
    description: readableFailure(
      squashAtomCommandFailure(result),
      "The tracker refused it. Check your access to this issue.",
    ),
  });
  return false;
}
