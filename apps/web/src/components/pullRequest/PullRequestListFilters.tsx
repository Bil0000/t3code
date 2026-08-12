import type {
  EnvironmentId,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListState,
} from "@t3tools/contracts";

import {
  ALL_HOSTS_VALUE,
  ListFilterMenu,
  ListFilterRadioGroup,
  ListProjectFilterGroup,
  type ListFilterOption,
} from "../sourceControl/ListFilterMenu";
import { MenuSeparator } from "../ui/menu";

export function PullRequestFiltersMenu({
  state,
  stateOptions,
  onState,
  involvement,
  involvementOptions,
  onInvolvement,
  host,
  hostOptions,
  onHost,
  environmentId,
  projects,
  projectId,
  unavailable,
  onProject,
}: {
  state: PullRequestListState;
  stateOptions: ReadonlyArray<ListFilterOption<PullRequestListState>>;
  onState: (state: PullRequestListState) => void;
  involvement: PullRequestInvolvement;
  involvementOptions: ReadonlyArray<ListFilterOption<PullRequestInvolvement>>;
  onInvolvement: (involvement: PullRequestInvolvement) => void;
  host: string | undefined;
  /**
   * Includes the "all hosts" entry, whose value is the empty string. With fewer than two real
   * hosts there is nothing to switch between, so the whole group stays out of the menu.
   */
  hostOptions: ReadonlyArray<ListFilterOption<string>>;
  onHost: (host: string | undefined) => void;
  /** Where the projects' own favicons are read from; null before the environment is known. */
  environmentId: EnvironmentId | null;
  projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
  }>;
  projectId: ProjectId | undefined;
  /**
   * Projects whose repository could not be read this time round. They are named here, where
   * the reader is already choosing between projects, rather than as a count above the list
   * that says something is missing without saying which.
   */
  unavailable: ReadonlyMap<ProjectId, string>;
  onProject: (projectId: ProjectId | undefined) => void;
}) {
  const filtered =
    state !== "open" || involvement !== "all" || host !== undefined || projectId !== undefined;
  return (
    <ListFilterMenu label="Filter pull requests" filtered={filtered}>
      <ListFilterRadioGroup label="State" value={state} options={stateOptions} onChange={onState} />
      <MenuSeparator />
      <ListFilterRadioGroup
        label="Involvement"
        value={involvement}
        options={involvementOptions}
        onChange={onInvolvement}
      />
      {hostOptions.length > 2 ? (
        <>
          <MenuSeparator />
          <ListFilterRadioGroup
            label="Host"
            value={host ?? ALL_HOSTS_VALUE}
            options={hostOptions}
            onChange={(next) => onHost(next === ALL_HOSTS_VALUE ? undefined : next)}
          />
        </>
      ) : null}
      <MenuSeparator />
      <ListProjectFilterGroup
        environmentId={environmentId}
        projects={projects}
        projectId={projectId}
        unavailable={unavailable}
        onProject={onProject}
      />
    </ListFilterMenu>
  );
}
