import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { changedPathParts } from "./diffFileTree.logic";

interface DiffRenameProps {
  readonly previousPath: string;
  readonly path: string;
  readonly withChanges?: boolean;
}

export function DiffRenameDetails({ previousPath, path, withChanges }: DiffRenameProps) {
  const parts = changedPathParts(previousPath, path);
  return (
    <div className="min-w-0 max-w-[min(32rem,80vw)] space-y-1.5 text-left">
      <div className="font-medium">{withChanges ? "Renamed and modified" : "Renamed"}</div>
      <div className="overflow-hidden rounded border border-border/60 font-mono leading-5 text-muted-foreground">
        <div className="grid grid-cols-[1rem_minmax(0,1fr)] gap-1 bg-error/8 px-2 py-0.5">
          <span className="select-none text-center text-error-foreground" aria-hidden="true">
            −
          </span>
          <span className="min-w-0 break-all [text-wrap:wrap]">
            <span className="sr-only">Previous path: </span>
            {parts.prefix}
            <span className="rounded-sm bg-error/20 text-error-foreground">{parts.before}</span>
            {parts.suffix}
          </span>
        </div>
        <div className="grid grid-cols-[1rem_minmax(0,1fr)] gap-1 bg-success/8 px-2 py-0.5">
          <span className="select-none text-center text-success-foreground" aria-hidden="true">
            +
          </span>
          <span className="min-w-0 break-all [text-wrap:wrap]">
            <span className="sr-only">New path: </span>
            {parts.prefix}
            <span className="rounded-sm bg-success/20 text-success-foreground">{parts.after}</span>
            {parts.suffix}
          </span>
        </div>
      </div>
    </div>
  );
}

export function DiffRenameBadge(props: DiffRenameProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} />}
        className="ml-1 shrink-0 rounded bg-warning/10 px-1 py-0.5 text-[10px] text-warning-foreground"
        aria-label={`${props.withChanges ? "Renamed and modified" : "Renamed"}: ${props.previousPath} → ${props.path}`}
      >
        Renamed
      </TooltipTrigger>
      <TooltipPopup>
        <DiffRenameDetails {...props} />
      </TooltipPopup>
    </Tooltip>
  );
}
