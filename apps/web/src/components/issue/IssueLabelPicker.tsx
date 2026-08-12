/**
 * Putting labels on an issue, from the row that says which it wears.
 *
 * What a repository has is read only once this menu opens: a long-lived repository has dozens of
 * labels, which is worth a request when somebody wants to change one and worth nothing on every
 * issue they merely open.
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueLabelCandidate, IssueRef } from "@t3tools/contracts";
import { CheckIcon, TagIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { readableFailure } from "../sourceControl/handoff";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A repository with dozens of labels is common, so what arrived can be narrowed here. It
 * narrows only what arrived: the host is asked once, when the menu opens. */
function matches(candidate: IssueLabelCandidate, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return (
    candidate.name.toLowerCase().includes(needle) ||
    (candidate.description ?? "").toLowerCase().includes(needle)
  );
}

export function IssueLabelPicker({
  environmentId,
  reference,
  applied,
  allowed,
  open,
  onOpenChange,
  onChanged,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  /**
   * The labels the issue wears, by name, as the issue itself reports them. Every host writes
   * labels by replacing the whole set, so the set sent back is built from these rather than from
   * the candidate list — which the host may have cut short, and which would then quietly take
   * off every label past its end.
   */
  applied: ReadonlyArray<string>;
  /** False where the host would refuse this account, which is worth saying rather than hiding:
   * the control disabled with a reason answers the question its absence would raise. */
  allowed: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The detail carries the labels, so it is re-read once the host has taken the change. */
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  // Mounted with the menu closed, so nothing is asked of the host until it opens.
  const candidatesQuery = useEnvironmentQuery(
    open ? issueEnvironment.labelCandidates({ environmentId, input: reference }) : null,
  );
  const setLabels = useAtomCommand(issueEnvironment.setLabels, { reportFailure: false });

  const candidates = useMemo(
    () => (candidatesQuery.data?.candidates ?? []).filter((entry) => matches(entry, query)),
    [candidatesQuery.data, query],
  );
  const appliedNames = useMemo(() => new Set(applied), [applied]);

  const toggle = async (candidate: IssueLabelCandidate) => {
    if (pending !== null) return;
    const isApplied = appliedNames.has(candidate.name);
    const next = isApplied
      ? applied.filter((name) => name !== candidate.name)
      : [...applied, candidate.name];
    setPending(candidate.name);
    const result = await setLabels({ environmentId, input: { ...reference, labels: next } });
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: isApplied
          ? `Could not take the \`${candidate.name}\` label off`
          : `Could not put the \`${candidate.name}\` label on`,
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused it. Check that you have write access on this repository, and that the label still exists.",
        ),
      });
      return;
    }
    onChanged();
    candidatesQuery.refresh();
  };

  if (!allowed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="icon-xs" variant="ghost" disabled aria-label="Change the labels">
              <TagIcon className="size-3.5" />
            </Button>
          }
        />
        <TooltipPopup side="bottom">
          Changing labels needs write access on this repository
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger
        render={
          <Button size="icon-xs" variant="ghost" aria-label="Change the labels">
            <TagIcon className="size-3.5" />
          </Button>
        }
      />
      <MenuPopup align="start" side="bottom" className="w-72 p-0">
        <div className="border-b border-border/60 p-2">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search labels"
            aria-label="Search labels"
            className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {candidatesQuery.isPending ? (
            <p className="p-2 text-xs text-muted-foreground">Reading this repository's labels…</p>
          ) : candidatesQuery.error !== null ? (
            <p className="p-2 text-xs text-muted-foreground">
              The labels could not be read. {candidatesQuery.error}
            </p>
          ) : candidates.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              {query.length > 0
                ? "No label matches that."
                : "This repository has no labels to put on."}
            </p>
          ) : (
            candidates.map((candidate) => (
              <button
                key={candidate.name}
                type="button"
                disabled={pending !== null}
                onClick={() => void toggle(candidate)}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/60 disabled:opacity-60"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{candidate.name}</span>
                  {candidate.description ? (
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {candidate.description}
                    </span>
                  ) : null}
                </span>
                {appliedNames.has(candidate.name) ? (
                  <CheckIcon aria-label="Already on" className="mt-0.5 size-3.5 shrink-0" />
                ) : null}
              </button>
            ))
          )}
          {candidatesQuery.data?.truncated ? (
            // Typing filters what arrived; it does not ask the host again, so this says what the
            // list is rather than offering a search that would find nothing further.
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              This repository has more labels than are listed here. Put the rest on from the host.
            </p>
          ) : null}
        </div>
      </MenuPopup>
    </Menu>
  );
}
