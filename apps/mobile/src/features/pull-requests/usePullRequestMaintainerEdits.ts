import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { canEditPullRequestMaintainerEdits } from "@t3tools/client-runtime/pull-request-editing";
import type { PullRequestDetail } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import * as Dialog from "../../components/ui/Dialog";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestConnected } from "./usePullRequestConnected";

export function usePullRequestMaintainerEdits(
  params: PullRequestParams,
  pr: PullRequestDetail | null,
) {
  const target = pullRequestTarget(params);
  const connected = usePullRequestConnected(target.environmentId);
  const canUpdate = useAtomValue(composerPullRequests.update.permissionAtom(target.environmentId));
  const allowed = connected && canUpdate;
  const update = useAtomCommand(composerPullRequests.update, { reportFailure: false });
  const refresh = useAtomRefresh(composerPullRequests.detail(target));
  const key = `${pr?.url}:${pr?.maintainerCanModify}`;
  const [saving, setSaving] = useState(false);
  const [selection, setSelection] = useState({ key, value: pr?.maintainerCanModify ?? false });
  const value =
    selection.key === key || saving ? selection.value : (pr?.maintainerCanModify ?? false);
  if (selection.key !== key) {
    setSelection({ key, value });
  }
  const inFlight = useRef(false);
  const visible = pr !== null && canEditPullRequestMaintainerEdits(pr);
  const save = async (next: boolean) => {
    if (!visible || !allowed || inFlight.current) return;
    const previous = value;
    inFlight.current = true;
    setSaving(true);
    setSelection({ key, value: next });
    const result = await update({
      ...target,
      input: { ...target.input, maintainerCanModify: next },
    });
    inFlight.current = false;
    setSaving(false);
    if (AsyncResult.isFailure(result)) {
      setSelection({ key, value: previous });
      Dialog.alert("Could not save maintainer access", "Try again.");
      return;
    }
    refresh();
  };

  return {
    visible,
    value,
    disabled: !allowed || saving,
    subtitle: saving
      ? "Saving…"
      : "Maintainers can push to this branch and access fork workflow secrets.",
    toggle: () => void save(!value),
  };
}
