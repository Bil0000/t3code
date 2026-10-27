import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { useId, useRef, useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { MenuCheckboxItem } from "../ui/menu";
import { toastManager } from "../ui/toast";

export function PullRequestMaintainerEdits({
  environmentId,
  reference,
  enabled,
  allowed,
  onSaved,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  enabled: boolean;
  allowed: boolean;
  onSaved: () => void;
}) {
  const id = useId();
  const update = useAtomCommand(pullRequestEnvironment.update, { reportFailure: false });
  const [value, setValue] = useState(enabled);
  const [saving, setSaving] = useState(false);
  const [observedValue, setObservedValue] = useState(enabled);
  if (observedValue !== enabled) {
    setObservedValue(enabled);
    if (!saving) setValue(enabled);
  }
  const inFlight = useRef(false);
  const save = async (next: boolean) => {
    if (!allowed || inFlight.current) return;
    const previous = value;
    inFlight.current = true;
    setSaving(true);
    setValue(next);
    const result = await update({
      environmentId,
      input: { ...reference, maintainerCanModify: next },
    });
    inFlight.current = false;
    setSaving(false);
    if (result._tag === "Failure") {
      setValue(previous);
      toastManager.add({
        type: "error",
        title: "Could not save maintainer access",
        description: "Try again.",
      });
      return;
    }
    onSaved();
  };

  return (
    <MenuCheckboxItem
      checked={value}
      disabled={!allowed || saving}
      closeOnClick={false}
      aria-label="Allow edits from maintainers"
      aria-describedby={`${id}-hint`}
      onCheckedChange={(next) => void save(next)}
    >
      <span className="flex max-w-xs flex-col gap-0.5">
        <span>Allow edits from maintainers</span>
        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
          Maintainers can push to this branch. If your fork has workflows, this can also give access
          to its secrets.
        </span>
        {saving ? (
          <span role="status" className="text-xs text-muted-foreground">
            Saving…
          </span>
        ) : null}
      </span>
    </MenuCheckboxItem>
  );
}
