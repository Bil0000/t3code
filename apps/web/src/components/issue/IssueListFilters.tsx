import type {
  EnvironmentId,
  IssueInvolvement,
  IssueListState,
  ProjectId,
} from "@t3tools/contracts";
import { TagIcon, TagsIcon } from "lucide-react";

import {
  ALL_HOSTS_VALUE,
  ListFilterMenu,
  ListFilterRadioGroup,
  ListProjectFilterGroup,
  type ListFilterOption,
} from "../sourceControl/ListFilterMenu";
import { MenuSeparator } from "../ui/menu";

/** A label name is never empty, so the same trick the hosts use names "every label". */
const ALL_LABELS_VALUE = "";

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
