import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useProjects } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";

import { readableFailure } from "../sourceControl/handoff";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

/**
 * A list written by hand, since a new issue has no reference for the candidate reads a picker
 * would use. Split on commas rather than on whitespace: a GitHub label is `good first issue`,
 * spaces and all.
 */
function parseList(value: string): ReadonlyArray<string> {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The repository an issue would be filed against, as the host spells it, or null where this
 * project has no host to file one on. A project checked out from nothing in particular is not a
 * place issues live, so it is left out of the picker rather than offered and refused.
 */
function repositoryOf(identity: {
  readonly displayName?: string | undefined;
  readonly owner?: string | undefined;
  readonly name?: string | undefined;
}): string | null {
  if (identity.displayName) return identity.displayName;
  return identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null;
}

export function IssueCreateDialog({
  open,
  onOpenChange,
  environmentId,
  projects,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  /** The projects the page is scoped to, in the order it lists them. */
  projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
  }>;
  /** What the page is currently narrowed to, which is the project to open on. */
  projectId: ProjectId | undefined;
  /** Where the issue landed, so the page can open it and re-read the list it was filed from. */
  onCreated: (created: {
    projectId: ProjectId;
    repository: string;
    number: number;
    url: string;
  }) => void;
}) {
  const [selectedId, setSelectedId] = useState<ProjectId | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const [assignees, setAssignees] = useState("");
  const [filing, setFiling] = useState(false);
  const create = useAtomCommand(issueEnvironment.create, { reportFailure: false });

  // The page hands over the projects it lists; their repositories come from the workspace, which
  // is the only thing that knows what each one was cloned from.
  const allProjects = useProjects();
  const candidates = useMemo(() => {
    const repositoryById = new Map(
      allProjects.flatMap((project) => {
        const repository = project.repositoryIdentity
          ? repositoryOf(project.repositoryIdentity)
          : null;
        return repository === null ? [] : [[project.id, repository] as const];
      }),
    );
    return projects.flatMap((project) => {
      const repository = repositoryById.get(project.id);
      return repository === undefined ? [] : [{ ...project, repository }];
    });
  }, [allProjects, projects]);

  // What the page is scoped to, unless the reader has since chosen otherwise. Derived rather than
  // held, so a project list that arrives after the dialog opens still lands on the right one.
  const selected =
    candidates.find((project) => project.id === selectedId) ??
    candidates.find((project) => project.id === projectId) ??
    candidates[0];
  const trimmedTitle = title.trim();

  const submit = async () => {
    if (selected === undefined || trimmedTitle.length === 0 || filing) return;
    setFiling(true);
    const result = await create({
      environmentId,
      input: {
        projectId: selected.id,
        repository: selected.repository,
        title: trimmedTitle,
        body,
        labels: parseList(labels),
        assignees: parseList(assignees),
      },
    });
    setFiling(false);
    if (result._tag === "Failure") {
      // The host's own sentence: a label that does not exist, a tracker switched off for this
      // repository and an account without access are three different refusals, and only the host
      // knows which one this was.
      toastManager.add({
        type: "error",
        title: "Could not file this issue",
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused it. Check that you have access to this repository, and that its issue tracker is on.",
        ),
      });
      return;
    }
    toastManager.add({ type: "success", title: `Filed issue #${result.value.number}` });
    setTitle("");
    setBody("");
    setLabels("");
    setAssignees("");
    onOpenChange(false);
    onCreated({
      projectId: selected.id,
      repository: selected.repository,
      number: result.value.number,
      url: result.value.url,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New issue</DialogTitle>
          <DialogDescription>
            Filed on the host this project is checked out from, as you.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {selected === undefined ? (
            <p className="text-sm text-muted-foreground">
              None of these projects is checked out from a host that takes issues. Add a project
              with a GitHub, GitLab, Bitbucket or Azure DevOps remote, then file one from here.
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                <label
                  className="text-xs font-medium text-muted-foreground"
                  htmlFor="issue-project"
                >
                  Project
                </label>
                <Select
                  value={selected.id}
                  onValueChange={(value) => setSelectedId(value as ProjectId)}
                >
                  <SelectTrigger id="issue-project" className="w-full" aria-label="Project">
                    <SelectValue>{selected.title}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {candidates.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {/* Read-only, because it is the project's own remote rather than a choice: filing
                    against another repository is choosing another project. */}
                <p className="truncate text-xs text-muted-foreground" title={selected.repository}>
                  {selected.repository}
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="issue-title">
                  Title
                </label>
                <Input
                  id="issue-title"
                  autoFocus
                  disabled={filing}
                  value={title}
                  placeholder="What is happening, in one line"
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="issue-body">
                  Description
                </label>
                <Textarea
                  id="issue-body"
                  disabled={filing}
                  value={body}
                  rows={8}
                  placeholder="Markdown. What you did, what happened, what you expected."
                  onChange={(event) => setBody(event.target.value)}
                />
              </div>

              {/* Typed rather than picked: a repository's labels and the people who may be
                  assigned are read against an issue, and this one does not exist yet. Both are
                  optional, and anything the host does not recognise it refuses by name. */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label
                    className="text-xs font-medium text-muted-foreground"
                    htmlFor="issue-labels"
                  >
                    Labels
                  </label>
                  <Input
                    id="issue-labels"
                    disabled={filing}
                    value={labels}
                    placeholder="bug, good first issue"
                    onChange={(event) => setLabels(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    className="text-xs font-medium text-muted-foreground"
                    htmlFor="issue-assignees"
                  >
                    Assignees
                  </label>
                  <Input
                    id="issue-assignees"
                    disabled={filing}
                    value={assignees}
                    placeholder="octocat, hubot"
                    onChange={(event) => setAssignees(event.target.value)}
                  />
                </div>
              </div>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={filing} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={selected === undefined || trimmedTitle.length === 0 || filing}
            onClick={() => void submit()}
          >
            <PlusIcon />
            {filing ? "Filing..." : "File issue"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
