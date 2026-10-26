import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { useId, useRef, useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { Checkbox } from "../ui/checkbox";

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
  const [error, setError] = useState(false);
  const inFlight = useRef(false);
  const save = async (next: boolean) => {
    if (!allowed || inFlight.current) return;
    const previous = value;
    inFlight.current = true;
    setSaving(true);
    setError(false);
    setValue(next);
    const result = await update({
      environmentId,
      input: { ...reference, maintainerCanModify: next },
    });
    inFlight.current = false;
    setSaving(false);
    if (result._tag === "Failure") {
      setValue(previous);
      setError(true);
      return;
    }
    onSaved();
  };

  return (
    <div className="mt-4 border-t border-border/60 pt-3">
      <div className="flex items-start gap-2.5 text-xs">
        <span className="pt-0.5">
          <Checkbox
            id={id}
            checked={value}
            disabled={!allowed || saving}
            aria-describedby={`${id}-hint`}
            onCheckedChange={(next) => void save(next)}
          />
        </span>
        <div className="min-w-0 space-y-1">
          <label htmlFor={id} className="block font-medium text-foreground">
            Allow edits from maintainers
          </label>
          <span id={`${id}-hint`} className="block max-w-sm leading-relaxed text-muted-foreground">
            Maintainers can push to this branch. If your fork has workflows, this can also give
            access to its secrets.
          </span>
        </div>
      </div>
      {saving ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Saving…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          Could not save maintainer access. Try again.
        </p>
      ) : null}
    </div>
  );
}
