import type {
  EnvironmentId,
  IssueInvolvement,
  IssueListOrder,
  IssueListSort,
  IssueListState,
  ProjectId,
} from "@t3tools/contracts";
import { ArrowDownUpIcon, TagIcon, TagsIcon } from "lucide-react";

import {
  ALL_HOSTS_VALUE,
  LIST_MENU_TRIGGER_CLASS_NAME,
  ListFilterMenu,
  ListFilterRadioGroup,
  ListProjectFilterGroup,
  type ListFilterOption,
} from "../sourceControl/ListFilterMenu";
import {
  Menu,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { issueListOrderLabels } from "./issueList.logic";

/** A label name is never empty, so the same trick the hosts use names "every label". */
const ALL_LABELS_VALUE = "";

const REACTION_SORTS = [
  ["reactions", "Total reactions", ""],
  ["reactions-thumbs-up", "Thumbs up", "👍"],
  ["reactions-thumbs-down", "Thumbs down", "👎"],
  ["reactions-rocket", "Rocket", "🚀"],
  ["reactions-hooray", "Hooray", "🎉"],
  ["reactions-eyes", "Eyes", "👀"],
  ["reactions-heart", "Heart", "❤️"],
  ["reactions-laugh", "Laugh", "😄"],
  ["reactions-confused", "Confused", "😕"],
] as const satisfies ReadonlyArray<readonly [IssueListSort, string, string]>;

export function IssueSortMenu({
  sort,
  order,
  onSort,
  onOrder,
}: {
  readonly sort: IssueListSort;
  readonly order: IssueListOrder;
  readonly onSort: (sort: IssueListSort) => void;
  readonly onOrder: (order: IssueListOrder) => void;
}) {
  const chooseSort = (value: string) => {
    if (value !== sort) onSort(value as IssueListSort);
  };
  const [ascendingLabel, descendingLabel] = issueListOrderLabels(sort);
  return (
    <Menu>
      <MenuTrigger
        className={LIST_MENU_TRIGGER_CLASS_NAME}
        aria-label="Sort issues"
        title="Sort issues"
      >
        <ArrowDownUpIcon className="size-4" />
        {sort !== "updated" || order !== "desc" ? (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary"
          />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-48">
        <MenuRadioGroup value={sort} onValueChange={chooseSort}>
          <MenuGroupLabel>Sort by</MenuGroupLabel>
          <MenuRadioItem value="created">Created on</MenuRadioItem>
          <MenuRadioItem value="updated">Last updated</MenuRadioItem>
          <MenuRadioItem value="comments">Total comments</MenuRadioItem>
          <MenuRadioItem value="best-match">Best match</MenuRadioItem>
        </MenuRadioGroup>
        <MenuSub>
          <MenuSubTrigger>Reactions</MenuSubTrigger>
          <MenuSubPopup className="min-w-48">
            <MenuRadioGroup value={sort} onValueChange={chooseSort}>
              {REACTION_SORTS.map(([value, label, emoji]) => (
                <MenuRadioItem key={value} value={value}>
                  <span className="flex items-center gap-2">
                    {emoji ? <span aria-hidden>{emoji}</span> : null}
                    {label}
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuRadioGroup
          value={order}
          onValueChange={(value) => {
            if (value !== order) onOrder(value as IssueListOrder);
          }}
        >
          <MenuGroupLabel>Order</MenuGroupLabel>
          <MenuRadioItem value="asc">{ascendingLabel}</MenuRadioItem>
          <MenuRadioItem value="desc">{descendingLabel}</MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

export function IssueFiltersMenu({
  state,
  stateOptions,
  onState,
  involvement,
  involvementOptions,
  onInvolvement,
  hostFilter,
  projectFilter,
  label,
  labels,
  onLabel,
}: {
  state: IssueListState;
  stateOptions: ReadonlyArray<ListFilterOption<IssueListState>>;
  onState: (state: IssueListState) => void;
  involvement: IssueInvolvement;
  involvementOptions: ReadonlyArray<ListFilterOption<IssueInvolvement>>;
  onInvolvement: (involvement: IssueInvolvement) => void;
  /**
   * Absent where the caller already knows the host, which is a surface listing one repository:
   * a group offering the only host there is says nothing.
   */
  hostFilter?: {
    readonly host: string | undefined;
    /**
     * Includes the "all hosts" entry, whose value is the empty string. With fewer than two real
     * hosts there is nothing to switch between, so the whole group stays out of the menu.
     */
    readonly hostOptions: ReadonlyArray<ListFilterOption<string>>;
    readonly onHost: (host: string | undefined) => void;
  };
  /** Absent for the same reason `hostFilter` is: one project is not a choice. */
  projectFilter?: {
    readonly environmentId: EnvironmentId | null;
    readonly projects: ReadonlyArray<{
      readonly id: ProjectId;
      readonly title: string;
      readonly workspaceRoot: string;
    }>;
    readonly projectId: ProjectId | undefined;
    readonly unavailable: ReadonlyMap<ProjectId, string>;
    readonly onProject: (projectId: ProjectId | undefined) => void;
  };
  label: string | undefined;
  /**
   * The labels the loaded rows actually wear, as names. No host is asked about a label, so this
   * narrows what has already arrived and can only ever offer what is on the page — which is why
   * the caller passes names rather than options: every one of them wears the same icon.
   */
  labels: ReadonlyArray<string>;
  onLabel: (label: string | undefined) => void;
}) {
  const filtered =
    state !== "open" ||
    involvement !== "all" ||
    hostFilter?.host !== undefined ||
    projectFilter?.projectId !== undefined ||
    label !== undefined;
  return (
    <ListFilterMenu label="Filter issues" filtered={filtered}>
      <ListFilterRadioGroup label="State" value={state} options={stateOptions} onChange={onState} />
      <MenuSeparator />
      <ListFilterRadioGroup
        label="Involvement"
        value={involvement}
        options={involvementOptions}
        onChange={onInvolvement}
      />
      {hostFilter !== undefined && hostFilter.hostOptions.length > 2 ? (
        <>
          <MenuSeparator />
          <ListFilterRadioGroup
            label="Host"
            value={hostFilter.host ?? ALL_HOSTS_VALUE}
            options={hostFilter.hostOptions}
            onChange={(next) => hostFilter.onHost(next === ALL_HOSTS_VALUE ? undefined : next)}
          />
        </>
      ) : null}
      {projectFilter === undefined ? null : (
        <>
          <MenuSeparator />
          <ListProjectFilterGroup
            environmentId={projectFilter.environmentId}
            projects={projectFilter.projects}
            projectId={projectFilter.projectId}
            unavailable={projectFilter.unavailable}
            onProject={projectFilter.onProject}
          />
        </>
      )}
      {/* Nothing loaded wears a label: there is no choice to offer, and a lone "All labels"
          row would only say so in the least useful place. */}
      {labels.length > 0 ? (
        <>
          <MenuSeparator />
          <ListFilterRadioGroup
            label="Label"
            value={label ?? ALL_LABELS_VALUE}
            options={[
              { value: ALL_LABELS_VALUE, label: "All labels", Icon: TagsIcon },
              ...labels.map((name) => ({ value: name, label: name, Icon: TagIcon })),
            ]}
            onChange={(next) => onLabel(next === ALL_LABELS_VALUE ? undefined : next)}
          />
        </>
      ) : null}
    </ListFilterMenu>
  );
}
