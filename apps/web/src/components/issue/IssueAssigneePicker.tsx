/**
 * Assigning an issue, from the row that says who has it.
 *
 * The people who may be assigned are read only once this menu opens: on a large repository that
 * is a list of everyone with access, which is worth a request when somebody wants it and worth
 * nothing on every issue they merely open.
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueAssigneeCandidate, IssueRef } from "@t3tools/contracts";
import { CheckIcon, UserPlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { SourceControlActorLabel } from "../sourceControl/actorPresentation";
import { readableFailure } from "../sourceControl/handoff";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Long lists are common — an organisation repository lists everyone — so what arrived can be
 * narrowed here. It narrows only what arrived: the host is asked once, when the menu opens. */
function matches(candidate: IssueAssigneeCandidate, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return (
    candidate.login.toLowerCase().includes(needle) ||
    (candidate.name ?? "").toLowerCase().includes(needle)
  );
}

export function IssueAssigneePicker({
  environmentId,
  reference,
  allowed,
  open,
  onOpenChange,
  onChanged,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  /** False where the host would refuse this account, which is worth saying rather than hiding:
   * the control disabled with a reason answers the question its absence would raise. */
  allowed: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The detail carries who is assigned, so it is re-read once the host has taken the change. */
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  // Mounted with the menu closed, so nothing is asked of the host until it opens.
  const candidatesQuery = useEnvironmentQuery(
    open ? issueEnvironment.assigneeCandidates({ environmentId, input: reference }) : null,
  );
  const setAssignees = useAtomCommand(issueEnvironment.setAssignees, { reportFailure: false });

  const all = useMemo(() => candidatesQuery.data?.candidates ?? [], [candidatesQuery.data]);
  const candidates = useMemo(() => all.filter((entry) => matches(entry, query)), [all, query]);

  const toggle = async (candidate: IssueAssigneeCandidate) => {
    if (pending !== null) return;
    // Every host writes assignees by replacing the whole set, and addresses a person by an
    // identifier the issue itself does not carry — GitLab assigns by numeric user id. So the set
    // is rebuilt from this list rather than from the issue's own assignees, which is also why
    // whoever already has it is listed here: a host that can assign somebody can name them.
    const next = candidate.isAssigned
      ? all.flatMap((entry) => (entry.isAssigned && entry.id !== candidate.id ? [entry.id] : []))
      : [...all.flatMap((entry) => (entry.isAssigned ? [entry.id] : [])), candidate.id];
    setPending(candidate.id);
    const result = await setAssignees({ environmentId, input: { ...reference, assignees: next } });
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: candidate.isAssigned
          ? `Could not take this issue off ${candidate.login}`
          : `Could not assign this issue to ${candidate.login}`,
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused it. Check that you have write access on this repository, and that they still have access to it.",
        ),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: candidate.isAssigned
        ? `Taken off ${candidate.login}`
        : `Assigned to ${candidate.login}`,
    });
    onChanged();
    candidatesQuery.refresh();
  };

  if (!allowed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="icon-xs" variant="ghost" disabled aria-label="Change who is assigned">
              <UserPlusIcon className="size-3.5" />
            </Button>
          }
        />
        <TooltipPopup side="bottom">
          Assigning an issue needs write access on this repository
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger
        render={
          <Button size="icon-xs" variant="ghost" aria-label="Change who is assigned">
            <UserPlusIcon className="size-3.5" />
          </Button>
        }
      />
      <MenuPopup align="start" side="bottom" className="w-72 p-0">
        <div className="border-b border-border/60 p-2">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search people with access"
            aria-label="Search people with access"
            className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {candidatesQuery.isPending ? (
            <p className="p-2 text-xs text-muted-foreground">Reading who has access…</p>
          ) : candidatesQuery.error !== null ? (
            <p className="p-2 text-xs text-muted-foreground">
              The people with access could not be read. {candidatesQuery.error}
            </p>
          ) : candidates.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              {query.length > 0
                ? "Nobody with access matches that."
                : "Nobody else has access to this repository."}
            </p>
          ) : (
            candidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                disabled={pending !== null}
                onClick={() => void toggle(candidate)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/60 disabled:opacity-60"
              >
                <SourceControlActorLabel actor={candidate} className="min-w-0 flex-1 truncate" />
                {candidate.isAssigned ? (
                  <CheckIcon aria-label="Already assigned" className="size-3.5 shrink-0" />
                ) : null}
              </button>
            ))
          )}
          {candidatesQuery.data?.truncated ? (
            // Typing filters what arrived; it does not ask the host again, so this says what the
            // list is rather than offering a search that would find nothing further.
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              This repository has more people with access than are listed here. Assign the rest on
              the host.
            </p>
          ) : null}
        </div>
      </MenuPopup>
    </Menu>
  );
}
