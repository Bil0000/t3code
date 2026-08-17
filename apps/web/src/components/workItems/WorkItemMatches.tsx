import type {
  EnvironmentId,
  ProjectId,
  WorkItemMatch,
  WorkItemMatchInput,
  WorkItemMatchRelationship,
} from "@t3tools/contracts";
import { ArrowUpRightIcon, LoaderIcon, SparklesIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { findWorkItemMatches } from "~/state/workItems";
import { useAtomCommand } from "~/state/use-atom-command";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function WorkItemMatchButton({
  busy,
  disabled = false,
  loaded,
  onClick,
}: {
  busy: boolean;
  disabled?: boolean;
  loaded: boolean;
  onClick: () => void;
}) {
  return (
    <Button size="xs" variant="ghost" disabled={busy || disabled} onClick={onClick}>
      {busy ? (
        <LoaderIcon aria-hidden className="size-3 animate-spin" />
      ) : (
        <SparklesIcon aria-hidden className="size-3" />
      )}
      {busy ? "Finding..." : loaded ? "Refresh with AI" : "Find with AI"}
    </Button>
  );
}

export function WorkItemMatchRows({
  matches,
  emptyText,
  onOpen,
}: {
  matches: ReadonlyArray<WorkItemMatch>;
  emptyText: string;
  onOpen: (match: WorkItemMatch) => void;
}) {
  if (matches.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyText}</p>;
  }
  return (
    <div className="space-y-1">
      <p className="px-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Suggested by AI
      </p>
      {matches.map((match) => (
        <button
          key={`${match.provider}:${match.repository}#${match.number}`}
          type="button"
          className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/60"
          onClick={() => onOpen(match)}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">{match.title}</span>
            <span className="block text-[11px] text-muted-foreground">{match.reason}</span>
          </span>
          <Badge variant="outline" className="shrink-0 text-[9px]">
            {match.confidence === "high" ? "High confidence" : "Medium confidence"}
          </Badge>
          <ArrowUpRightIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

type MatchCache = {
  readonly key: string;
  readonly related?: ReadonlyArray<WorkItemMatch>;
  readonly duplicate?: ReadonlyArray<WorkItemMatch>;
};

export function useWorkItemMatches(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly source: WorkItemMatchInput["source"];
  readonly version: string;
}) {
  const run = useAtomCommand(findWorkItemMatches, { reportFailure: false });
  const key = `${input.projectId}:${input.source.kind}:${input.source.repository}#${input.source.number}:${input.version}`;
  const [cache, setCache] = useState<MatchCache>({ key });
  const [pending, setPending] = useState<WorkItemMatchRelationship | null>(null);
  const find = useCallback(
    async (relationship: WorkItemMatchRelationship) => {
      if (pending !== null) return;
      setPending(relationship);
      const response = await run({
        environmentId: input.environmentId,
        input: { projectId: input.projectId, source: input.source, relationship },
      });
      setPending(null);
      if (response._tag === "Failure") {
        toastManager.add({ type: "error", title: "Could not find matches" });
        return;
      }
      setCache((current) => ({
        ...(current.key === key ? current : { key }),
        [relationship]: response.value.matches,
      }));
    },
    [input.environmentId, input.projectId, input.source, key, pending, run],
  );
  const current = cache.key === key ? cache : { key };
  return { find, pending, related: current.related, duplicate: current.duplicate };
}
