import { useAtomRefresh } from "@effect/atom-react";
import type { PullRequestDetail } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";

export function PullRequestMaintainerEdits({
  params,
  pr,
}: {
  params: PullRequestParams;
  pr: PullRequestDetail;
}) {
  const target = pullRequestTarget(params);
  const permissions = usePullRequestPermissions(params, pr);
  const update = useAtomCommand(composerPullRequests.update, { reportFailure: false });
  const refresh = useAtomRefresh(composerPullRequests.detail(target));
  const [value, setValue] = useState(pr.maintainerCanModify ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const inFlight = useRef(false);
  const save = async (next: boolean) => {
    if (!permissions.canEditChangeRequest || inFlight.current) return;
    const previous = value;
    inFlight.current = true;
    setSaving(true);
    setError(false);
    setValue(next);
    const result = await update({
      ...target,
      input: { ...target.input, maintainerCanModify: next },
    });
    inFlight.current = false;
    setSaving(false);
    if (AsyncResult.isFailure(result)) {
      setValue(previous);
      setError(true);
      return;
    }
    refresh();
  };

  return (
    <View className="gap-2 border-t border-border-subtle pt-3">
      <ListToggleRow
        label="Allow edits from maintainers"
        description="Maintainers can push to this branch. If your fork has workflows, this can also give access to its secrets."
        value={value}
        disabled={!permissions.canEditChangeRequest || saving}
        onValueChange={(next) => void save(next)}
      />
      {saving ? (
        <AppText accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
          Saving…
        </AppText>
      ) : null}
      {error ? (
        <AppText accessibilityRole="alert" className="text-xs text-danger-foreground">
          Could not save maintainer access. Try again.
        </AppText>
      ) : null}
    </View>
  );
}
