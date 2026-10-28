import { useAtomRefresh } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PullRequestDetail } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import * as Dialog from "../../components/ui/Dialog";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";

export function usePullRequestMaintainerEdits(
  params: PullRequestParams,
  pr: PullRequestDetail | null,
) {
  const target = pullRequestTarget(params);
  const permissions = usePullRequestPermissions(params, pr);
  const update = useAtomCommand(composerPullRequests.update, { reportFailure: false });
  const refreshDetail = useAtomRefresh(composerPullRequests.detail(target));
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [choice, setChoice] = useState<{
    readonly url: string;
    readonly observed: boolean | undefined;
    readonly value: boolean;
  } | null>(null);
  const observed = pr?.maintainerCanModify;
  // A choice ends at the first host value that differs from the one it was made against, so a
  // later change made elsewhere is never masked by it.
  if (choice !== null && !saving && (choice.url !== pr?.url || choice.observed !== observed)) {
    setChoice(null);
  }
  const value = choice !== null && choice.url === pr?.url ? choice.value : observed === true;
  const save = async (next: boolean) => {
    if (pending.current || pr === null || !permissions.canEditMaintainerEdits) return;
    pending.current = true;
    const previousChoice = choice;
    setSaving(true);
    setChoice({ url: pr.url, observed, value: next });
    const response = await update({
      ...target,
      input: { ...target.input, maintainerCanModify: next },
    });
    pending.current = false;
    setSaving(false);
    if (AsyncResult.isFailure(response)) {
      setChoice(previousChoice);
      const cause = squashAtomCommandFailure(response);
      Dialog.alert(
        "Could not save maintainer access",
        cause instanceof Error ? cause.message : "Try again.",
      );
      return;
    }
    refreshDetail();
  };
  return {
    visible: permissions.canEditMaintainerEdits,
    value,
    saving,
    subtitle: saving
      ? "Saving…"
      : "Maintainers can push to this branch and may get access to fork workflow secrets.",
    toggle: () => void save(!value),
  };
}
