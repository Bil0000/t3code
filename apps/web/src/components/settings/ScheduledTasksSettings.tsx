import { useAtomValue } from "@effect/atom-react";
import { Clock3Icon, PencilIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ScheduledTask,
  ScheduledTaskConfigureFailoverInput,
  ScheduledTaskId,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import { CommandId, ProviderInstanceId, ScheduledTaskError } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { cn, randomUUID } from "../../lib/utils";
import { formatRelativeTime } from "../../timestampFormat";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  resolveScheduledTaskBaseRef,
  resolveScheduledTaskModelSelection,
  resolveScheduledTaskBackupModel,
} from "./ScheduledTasksSettings.logic";
import { ScheduledTaskBackupFields } from "./ScheduledTaskBackupFields";
import { ScheduledTaskBranchPicker } from "./ScheduledTaskBranchPicker";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

type ScheduleMode = "fixed" | "interval";
type WorkspaceMode = "root" | "worktree" | "existing_worktree";
const isScheduledTaskError = Schema.is(ScheduledTaskError);

async function taskCommandValue<A, E>(request: Promise<AtomCommandResult<A, E>>): Promise<A> {
  const result = await request;
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

interface DraftState {
  readonly editingId: string | null;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleMode: ScheduleMode;
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  readonly weekdays: ReadonlySet<number>;
  readonly projectId: string;
  readonly threadId: string;
  readonly workspaceMode: WorkspaceMode;
  readonly baseRef: string;
  readonly existingWorktreePath: string;
  readonly modelSelection: ModelSelection | null;
  readonly failover: ScheduledTask["failover"];
  /** Not editable in the dialog, but preserved so editing an agent-created task keeps its modes. */
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** JS day-of-week (0 = Sunday) rendered Monday-first, matching how people read a week. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const ALL_WEEKDAYS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5, 6]);

const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  worktree: "Create a new worktree",
  root: "Use the project checkout",
  existing_worktree: "Use a specific checkout",
};

const EMPTY_DRAFT: DraftState = {
  editingId: null,
  title: "",
  prompt: "",
  enabled: true,
  scheduleMode: "fixed",
  intervalMinutes: "15",
  timeOfDay: "09:00",
  weekdays: new Set([1, 2, 3, 4, 5]),
  projectId: "",
  threadId: "",
  workspaceMode: "worktree",
  baseRef: "",
  existingWorktreePath: "",
  modelSelection: null,
  failover: null,
  runtimeMode: "full-access",
  interactionMode: "default",
};

/** Labelled field: a caption sitting above its control. */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label
        className="flex items-baseline justify-between gap-2 text-xs font-medium text-foreground"
        htmlFor={htmlFor}
      >
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-[11px] text-muted-foreground/80">{hint}</span>
        ) : null}
      </label>
      {children}
    </div>
  );
}

function scheduleFromDraft(draft: DraftState): ScheduledTaskSchedule {
  if (draft.scheduleMode === "interval") {
    const minutes = Math.max(1, Number.parseInt(draft.intervalMinutes, 10) || 1);
    return { type: "interval", everyMs: minutes * 60_000 };
  }
  const selectedEveryDay = draft.weekdays.size === 0 || draft.weekdays.size === 7;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay || "09:00",
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
  };
}

export function scheduleLabel(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `Every ${minutes} min`
      : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}

/**
 * Human label for a run timestamp. `formatRelativeTime` only handles the
 * past, and `nextRunAt` is a future instant — render "in 5m" style labels
 * for upcoming runs instead of a misleading "just now".
 */
export function relativeLabel(value: string | null): string {
  if (!value) return "Not scheduled";
  const diffMs = new Date(value).getTime() - Date.now();
  if (diffMs <= 0) {
    const relative = formatRelativeTime(value);
    if (!relative) return "Not scheduled";
    return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
  }
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 2) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function taskToDraft(task: ScheduledTask): DraftState {
  const schedule = task.schedule;
  const weekdays =
    schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
      ? new Set(schedule.weekdays)
      : new Set(ALL_WEEKDAYS);
  return {
    editingId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    scheduleMode: schedule.type === "interval" ? "interval" : "fixed",
    intervalMinutes:
      schedule.type === "interval"
        ? String(Math.max(1, Math.round(schedule.everyMs / 60_000)))
        : "15",
    timeOfDay: schedule.type === "fixed_time" ? schedule.timeOfDay : "09:00",
    weekdays,
    projectId: task.projectId,
    threadId: task.threadId ?? "",
    workspaceMode: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "",
    existingWorktreePath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    modelSelection: task.modelSelection,
    failover: task.failover,
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
  };
}

function statusVariant(status: ScheduledTask["lastRunStatus"]) {
  if (status === "failed") return "error";
  if (status === "succeeded") return "success";
  if (status === "running") return "info";
  return "outline";
}

export function ScheduledTasksSettings(target: {
  readonly environmentId?: EnvironmentId;
  readonly taskId?: ScheduledTaskId;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const environment = useEnvironment(target.environmentId ?? primaryEnvironmentId);
  // Live subscription: the server pushes a fresh list after every change
  // (CRUD, run transitions, reschedules), so no manual refresh is needed.
  const tasksQuery = useEnvironmentQuery(
    environment
      ? serverEnvironment.scheduledTasksLive({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  return (
    <SettingsPageContainer className="max-w-3xl">
      <Field label="Host">
        <Select
          value={environment?.environmentId ?? null}
          onValueChange={(environmentId) => {
            if (environmentId)
              void navigate({ to: "/settings/scheduled-tasks", search: { environmentId } });
          }}
        >
          <SelectTrigger size="sm" aria-label="Host">
            <SelectValue placeholder="Select a host">{environment?.label}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {environments.map((entry) => (
              <SelectItem key={entry.environmentId} value={entry.environmentId}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <p className="text-xs text-muted-foreground">
          Tasks run on the selected host. Add a backup host to keep future runs going when it is
          offline. Closing the app does not stop tasks on a running host. Without a backup, fixed
          times use the host time zone.
        </p>
      </Field>
      {!environment || !tasksQuery.data ? (
        <p className="px-5 py-4 text-xs text-muted-foreground" role="status">
          {tasksQuery.error ??
            (environment
              ? "Loading automations…"
              : "Connect the selected host to manage automations.")}
        </p>
      ) : (
        <EnvironmentScheduledTasksSettings
          key={`${environment.environmentId}:${target.taskId ?? ""}`}
          environmentId={environment.environmentId}
          taskId={target.taskId}
          tasks={tasksQuery.data.tasks}
          error={tasksQuery.error}
        />
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentScheduledTasksSettings({
  environmentId,
  taskId,
  tasks,
  error,
}: {
  readonly environmentId: EnvironmentId;
  readonly taskId: ScheduledTaskId | undefined;
  readonly tasks: ReadonlyArray<ScheduledTask>;
  readonly error: string | null;
}) {
  useRelativeTimeTick(15_000);
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const [taskEnvironmentId, setTaskEnvironmentId] = useState(environmentId);
  const taskEnvironment = useEnvironment(taskEnvironmentId);
  const allProjects = useProjects();
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === taskEnvironmentId),
    [allProjects, taskEnvironmentId],
  );
  const settings = useEnvironmentSettings(taskEnvironmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(taskEnvironmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const upsertTask = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
  });
  const configureFailover = useAtomCommand(serverEnvironment.configureScheduledTaskFailover);
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled);
  const deleteTask = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
  });
  const runTaskNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run now",
  });
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const linkedTask = tasks.find((task) => task.id === taskId);
  // This component mounts after the first snapshot and is keyed by the link
  // target. Live task updates must not overwrite an open editor's draft.
  const [draft, setDraft] = useState<DraftState>(() =>
    linkedTask ? taskToDraft(linkedTask) : EMPTY_DRAFT,
  );
  const [automaticBackup, setAutomaticBackup] = useState(Boolean(linkedTask?.failover));
  const [backupEnvironmentId, setBackupEnvironmentId] = useState<EnvironmentId | null>(
    linkedTask?.failover?.environmentIds.find((id) => id !== environmentId) ?? null,
  );
  const [backupProjectId, setBackupProjectId] = useState<ProjectId | null>(null);
  const backupProviders =
    useAtomValue(serverEnvironment.providersValueAtom(backupEnvironmentId ?? taskEnvironmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const pendingConfiguration = useRef<ScheduledTaskConfigureFailoverInput | null>(null);
  const taskHostQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: taskEnvironmentId, input: {} }),
  );
  const backupQuery = useEnvironmentQuery(
    (automaticBackup || draft.failover) && backupEnvironmentId
      ? serverEnvironment.scheduledTasksLive({ environmentId: backupEnvironmentId, input: {} })
      : null,
  );
  const backupTask = draft.failover
    ? backupQuery.data?.tasks.find((task) => task.failover?.groupId === draft.failover?.groupId)
    : undefined;
  const selectedBackupProjectId = backupProjectId ?? backupTask?.projectId ?? null;
  const preferredHostId = draft.failover?.environmentIds[0];
  const openingMainHost = Boolean(
    draft.editingId && preferredHostId && preferredHostId !== taskEnvironmentId,
  );
  useEffect(() => {
    if (!openingMainHost || !preferredHostId || !backupTask) return;
    void navigate({
      to: "/settings/scheduled-tasks",
      search: { environmentId: preferredHostId, taskId: backupTask.id },
    });
  }, [openingMainHost, preferredHostId, backupTask, navigate]);
  const [dialogOpen, setDialogOpen] = useState(() => linkedTask !== undefined);
  const [saving, setSaving] = useState(false);
  const editingTaskMissing =
    draft.editingId !== null &&
    !taskHostQuery.data?.tasks.some((task) => task.id === draft.editingId);
  const selectedProject = projects.find((project) => project.id === draft.projectId);
  const refsQuery = useEnvironmentQuery(
    dialogOpen && draft.workspaceMode === "worktree" && selectedProject
      ? vcsEnvironment.listRefs({
          environmentId: taskEnvironmentId,
          input: { cwd: selectedProject.workspaceRoot, limit: 2 },
        })
      : null,
  );
  const baseRef = resolveScheduledTaskBaseRef(draft.baseRef, refsQuery.data?.refs ?? []);

  const firstInstance = instanceEntries[0];
  const defaultModelSelection =
    firstInstance && firstInstance.models[0]
      ? createModelSelection(firstInstance.instanceId, firstInstance.models[0].slug)
      : null;
  const activeSelection = draft.modelSelection ?? defaultModelSelection;
  const activeEntry = instanceEntries.find(
    (entry) => entry.instanceId === activeSelection?.instanceId,
  );
  const activeInstanceId =
    activeSelection?.instanceId ?? firstInstance?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = activeSelection?.model ?? "";
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, activeInstanceId, activeModel),
    [settings, providers, activeInstanceId, activeModel],
  );

  const backupModelSelection = resolveScheduledTaskBackupModel(
    activeSelection,
    activeEntry,
    backupProviders,
  );

  const openForCreate = useCallback(() => {
    setTaskEnvironmentId(environmentId);
    setAutomaticBackup(false);
    setBackupEnvironmentId(null);
    setBackupProjectId(null);
    pendingConfiguration.current = null;
    setDraft({
      ...EMPTY_DRAFT,
      projectId: allProjects.find((project) => project.environmentId === environmentId)?.id ?? "",
    });
    setDialogOpen(true);
  }, [allProjects, environmentId]);

  const openForEdit = useCallback(
    (task: ScheduledTask) => {
      setTaskEnvironmentId(environmentId);
      setAutomaticBackup(Boolean(task.failover));
      setBackupEnvironmentId(
        task.failover?.environmentIds.find((id) => id !== environmentId) ?? null,
      );
      setBackupProjectId(null);
      pendingConfiguration.current = null;
      setDraft(taskToDraft(task));
      setDialogOpen(true);
    },
    [environmentId],
  );

  const submit = async () => {
    if (saving || editingTaskMissing || openingMainHost) return;
    const modelSelection = activeSelection;
    if (
      !draft.title.trim() ||
      !draft.prompt.trim() ||
      !draft.projectId ||
      modelSelection === null
    ) {
      reportFailure("Schedule task is incomplete", "Add a title, prompt, project, and model.");
      return;
    }
    if (draft.workspaceMode === "worktree" && !baseRef) {
      reportFailure(
        "Branch is required",
        "Select a project and choose the branch for the new worktree.",
      );
      return;
    }
    if (!automaticBackup && draft.failover && !backupQuery.data) {
      reportFailure(
        "Backup host is not ready",
        "Connect the backup host before turning backup off.",
      );
      return;
    }
    if (
      automaticBackup &&
      (!backupEnvironmentId ||
        backupEnvironmentId === taskEnvironmentId ||
        !selectedBackupProjectId ||
        !backupModelSelection ||
        draft.workspaceMode === "existing_worktree" ||
        draft.threadId ||
        !taskHostQuery.data?.failoverAvailable ||
        !backupQuery.data?.failoverAvailable)
    ) {
      reportFailure(
        "Backup host is not ready",
        "Connect both hosts to the same T3 Connect account and select the matching backup project. The selected model and options must be available on both hosts. Use a new thread with the project checkout or a new worktree.",
      );
      return;
    }
    const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
      draft.workspaceMode === "root"
        ? { type: "root" }
        : draft.workspaceMode === "existing_worktree"
          ? { type: "existing_worktree", worktreePath: draft.existingWorktreePath.trim() }
          : { type: "worktree", baseRef, startFromOrigin: true };
    const input: ScheduledTaskUpsertInput = {
      ...(draft.editingId ? { id: draft.editingId as ScheduledTaskId } : {}),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      enabled: draft.enabled,
      schedule: scheduleFromDraft(draft),
      failover: null,
      projectId: draft.projectId as ProjectId,
      threadId: draft.threadId ? (draft.threadId as ThreadId) : null,
      workspaceStrategy,
      modelSelection,
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.interactionMode,
      creationSource: "web",
    };
    setSaving(true);
    let configured = false;
    try {
      if (
        automaticBackup &&
        backupEnvironmentId &&
        selectedBackupProjectId &&
        backupModelSelection
      ) {
        let previousFailover = draft.failover;
        if (pendingConfiguration.current) {
          const restored = await taskCommandValue(
            configureFailover({
              environmentId: taskEnvironmentId,
              input: pendingConfiguration.current,
            }),
          );
          previousFailover = restored.failover;
          pendingConfiguration.current = null;
          setDraft((current) => ({ ...current, failover: restored.failover }));
        }
        pendingConfiguration.current = {
          groupId: previousFailover?.groupId ?? randomUUID(),
          expectedRevision: previousFailover?.revision ?? null,
          revision: randomUUID(),
          environmentIds: previousFailover?.environmentIds.includes(backupEnvironmentId)
            ? previousFailover.environmentIds
            : [taskEnvironmentId, backupEnvironmentId],
          schedule: input.schedule,
          timeZone:
            previousFailover?.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
        const { failover } = await taskCommandValue(
          configureFailover({
            environmentId: taskEnvironmentId,
            input: pendingConfiguration.current,
          }),
        );
        pendingConfiguration.current = null;
        configured = true;
        setDraft((current) => ({ ...current, failover }));
        const sharedInput = {
          ...input,
          enabled: false,
          failover,
          commandId: CommandId.make(`scheduled-failover:${failover.groupId}`),
        };
        const { task } = await taskCommandValue(
          upsertTask({
            environmentId: taskEnvironmentId,
            input: sharedInput,
          }),
        );
        setDraft((current) => ({ ...current, editingId: task.id }));
        await taskCommandValue(
          upsertTask({
            environmentId: backupEnvironmentId,
            input: {
              ...sharedInput,
              id: backupTask?.id,
              projectId: selectedBackupProjectId,
              modelSelection: backupModelSelection,
            },
          }),
        );
        if (draft.enabled) {
          await taskCommandValue(
            setTaskEnabled({
              environmentId: taskEnvironmentId,
              input: { id: task.id, enabled: true },
            }),
          );
        }
      } else {
        await taskCommandValue(upsertTask({ environmentId: taskEnvironmentId, input }));
        if (draft.failover && backupEnvironmentId && backupTask) {
          await taskCommandValue(
            deleteTask({ environmentId: backupEnvironmentId, input: { id: backupTask.id } }),
          );
        }
      }
      setDialogOpen(false);
      if (taskEnvironmentId !== environmentId) {
        void navigate({
          to: "/settings/scheduled-tasks",
          search: { environmentId: taskEnvironmentId },
        });
      }
    } catch (error) {
      if (isScheduledTaskError(error) && error.recoveryFailover) {
        pendingConfiguration.current = null;
        setDraft((current) => ({ ...current, failover: error.recoveryFailover }));
      }
      reportFailure(
        configured ? "Task paused: backup setup did not finish" : "Could not save schedule task",
        error,
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = useCallback(
    async (task: ScheduledTask) => {
      const result = await deleteTask({
        environmentId,
        input: { id: task.id },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not delete schedule task", squashAtomCommandFailure(result));
      }
    },
    [deleteTask, environmentId],
  );

  const handleRunNow = useCallback(
    async (task: ScheduledTask) => {
      const result = await runTaskNow({
        environmentId,
        input: { id: task.id },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not run schedule task", squashAtomCommandFailure(result));
      }
    },
    [environmentId, runTaskNow],
  );

  // Keep the draft pointed at a real project once projects load, so a freshly
  // opened dialog is never stuck on an empty project select.
  useEffect(() => {
    if (draft.projectId || projects.length === 0) return;
    setDraft((current) => ({
      ...current,
      projectId: projects[0]?.id ?? "",
    }));
  }, [draft.projectId, projects]);

  return (
    <>
      <SettingsSection
        title="Schedule Tasks"
        icon={<Clock3Icon className="size-3.5" />}
        headerAction={
          <Button size="xs" variant="outline" onClick={openForCreate}>
            <PlusIcon className="size-3.5" />
            New
          </Button>
        }
      >
        {taskId && !linkedTask ? (
          <p className="px-5 py-4 text-xs text-muted-foreground" role="status">
            This automation no longer exists.
          </p>
        ) : null}
        {error ? (
          <div className="px-5 py-4 text-xs text-destructive">{error}</div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
            <div className="grid size-10 place-items-center rounded-full border border-border/70 bg-muted/40 text-muted-foreground">
              <Clock3Icon className="size-4.5" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">No schedule tasks yet</p>
              <p className="mx-auto max-w-xs text-xs text-muted-foreground">
                Create one to run a prompt on a schedule — on an interval or at a fixed time.
              </p>
            </div>
            <Button size="sm" onClick={openForCreate}>
              <PlusIcon className="size-3.5" />
              New task
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {tasks.map((task) => (
              <div key={task.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0 space-y-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-foreground">{task.title}</h3>
                    <Badge variant={task.enabled ? "success" : "outline"}>
                      {task.enabled ? "Enabled" : "Paused"}
                    </Badge>
                    <Badge variant={statusVariant(task.lastRunStatus)}>{task.lastRunStatus}</Badge>
                    {task.failover ? <Badge variant="outline">Automatic backup</Badge> : null}
                  </div>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{task.prompt}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground/80">
                    <span>{scheduleLabel(task.schedule)}</span>
                    <span>
                      Next: {task.enabled ? relativeLabel(task.nextRunAt) : "Not scheduled"}
                    </span>
                    <span>Runs: {task.runCount}</span>
                  </div>
                  {task.lastRunError ? (
                    <p className="text-[11px] text-destructive">{task.lastRunError}</p>
                  ) : null}
                </div>
                <div className="flex items-start gap-1">
                  <Switch
                    className="mr-2 mt-1"
                    checked={task.enabled}
                    aria-label={`${task.enabled ? "Pause" : "Enable"} ${task.title}`}
                    onCheckedChange={async (enabled) => {
                      const result = await setTaskEnabled({
                        environmentId,
                        input: { id: task.id, enabled },
                      });
                      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                        reportFailure(
                          "Could not update schedule task",
                          squashAtomCommandFailure(result),
                        );
                      }
                    }}
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Run ${task.title}`}
                          onClick={() => void handleRunNow(task)}
                        >
                          <PlayIcon className="size-4" />
                        </Button>
                      }
                    />
                    <TooltipPopup>Run now</TooltipPopup>
                  </Tooltip>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Edit ${task.title}`}
                    onClick={() => openForEdit(task)}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${task.title}`}
                    onClick={() => void handleDelete(task)}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!saving) setDialogOpen(open);
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{draft.editingId ? "Edit task" : "New task"}</DialogTitle>
            <DialogDescription>
              Run a prompt automatically — on an interval or at a fixed time.
            </DialogDescription>
          </DialogHeader>

          {openingMainHost ? (
            <p className="px-6 py-4 text-xs text-muted-foreground" role="status">
              {backupQuery.error
                ? "Connect the main host to edit this task."
                : backupQuery.data && !backupTask
                  ? "This task is no longer available on its main host."
                  : "Opening the task on its main host…"}
            </p>
          ) : null}
          <DialogPanel className={cn("space-y-5", openingMainHost && "hidden")}>
            {editingTaskMissing ? (
              <p className="text-xs text-destructive" role="status">
                This automation no longer exists.
              </p>
            ) : null}
            <Field label="Name" htmlFor="scheduled-task-title">
              <Input
                id="scheduled-task-title"
                placeholder="e.g. Check for Sentry issues"
                value={draft.title}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, title: event.target.value }))
                }
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Project">
                <Select
                  value={draft.projectId}
                  onValueChange={(projectId) =>
                    setDraft((current) => ({
                      ...current,
                      projectId: projectId ?? "",
                      baseRef: "",
                    }))
                  }
                >
                  <SelectTrigger size="sm">
                    <SelectValue placeholder="Select a project">
                      {selectedProject?.title}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>

              <Field label="Workspace">
                <Select
                  value={draft.workspaceMode}
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      workspaceMode: value as WorkspaceMode,
                    }))
                  }
                >
                  <SelectTrigger size="sm">
                    <SelectValue>{WORKSPACE_MODE_LABELS[draft.workspaceMode]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="worktree">Create a new worktree</SelectItem>
                    <SelectItem value="root">Use the project checkout</SelectItem>
                    <SelectItem value="existing_worktree" disabled={automaticBackup}>
                      Use a specific checkout
                    </SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
            </div>

            {draft.workspaceMode === "worktree" ? (
              <Field label="Branch" htmlFor="scheduled-task-branch">
                <ScheduledTaskBranchPicker
                  key={`${taskEnvironmentId}:${draft.projectId}`}
                  environmentId={taskEnvironmentId}
                  cwd={selectedProject?.workspaceRoot ?? null}
                  value={baseRef}
                  onChange={(branch) => setDraft((current) => ({ ...current, baseRef: branch }))}
                />
              </Field>
            ) : null}
            {draft.workspaceMode === "existing_worktree" ? (
              <Field label="Checkout path" htmlFor="scheduled-task-checkout">
                <Input
                  id="scheduled-task-checkout"
                  value={draft.existingWorktreePath}
                  placeholder="/path/to/checkout"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      existingWorktreePath: event.target.value,
                    }))
                  }
                />
              </Field>
            ) : null}

            <Field label="Prompt" htmlFor="scheduled-task-prompt">
              <Textarea
                id="scheduled-task-prompt"
                placeholder="What should the agent do each time this runs?"
                value={draft.prompt}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, prompt: event.target.value }))
                }
              />
            </Field>

            <Field label="Model">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <ProviderModelPicker
                  activeInstanceId={activeInstanceId}
                  model={activeModel}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  triggerVariant="outline"
                  triggerClassName="text-foreground/90 hover:text-foreground"
                  onInstanceModelChange={(instanceId, model) =>
                    setDraft((current) => ({
                      ...current,
                      modelSelection: resolveScheduledTaskModelSelection(
                        instanceId,
                        model,
                        current.modelSelection,
                        taskHostQuery.data?.tasks.find((task) => task.id === current.editingId)
                          ?.modelSelection,
                      ),
                    }))
                  }
                />
                {activeSelection && activeEntry ? (
                  <TraitsPicker
                    provider={activeEntry.driverKind}
                    models={activeEntry.models}
                    model={activeSelection.model}
                    prompt={draft.prompt}
                    onPromptChange={(prompt) => setDraft((current) => ({ ...current, prompt }))}
                    modelOptions={activeSelection.options}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={settings.planModeEnabled}
                    triggerVariant="outline"
                    onModelOptionsChange={(options) =>
                      setDraft((current) => ({
                        ...current,
                        modelSelection: createModelSelection(
                          activeSelection.instanceId,
                          activeSelection.model,
                          options,
                        ),
                      }))
                    }
                  />
                ) : null}
              </div>
            </Field>

            <div className="space-y-3 rounded-lg border border-border/70 p-3">
              <Field label="Main host">
                <Select
                  value={taskEnvironmentId}
                  disabled={draft.editingId !== null || saving}
                  onValueChange={(nextEnvironmentId) => {
                    if (!nextEnvironmentId || nextEnvironmentId === taskEnvironmentId) return;
                    setTaskEnvironmentId(nextEnvironmentId);
                    setAutomaticBackup(false);
                    setBackupEnvironmentId(null);
                    setBackupProjectId(null);
                    setDraft((current) => ({
                      ...current,
                      projectId: "",
                      threadId: "",
                      baseRef: "",
                      existingWorktreePath: "",
                      modelSelection: null,
                    }));
                  }}
                >
                  <SelectTrigger size="sm" aria-label="Main host">
                    <SelectValue>{taskEnvironment?.label}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {environments.map((entry) => (
                      <SelectItem key={entry.environmentId} value={entry.environmentId}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {draft.editingId ? (
                  <p className="text-xs text-muted-foreground">
                    To change the main host, create a task there and disable this one.
                  </p>
                ) : null}
              </Field>
              <div className="flex items-center justify-between gap-3">
                <label className="text-xs font-medium" htmlFor="scheduled-task-backup">
                  Use a backup host
                </label>
                <Switch
                  id="scheduled-task-backup"
                  checked={automaticBackup}
                  disabled={
                    saving ||
                    (!automaticBackup &&
                      (Boolean(draft.threadId) || draft.workspaceMode === "existing_worktree"))
                  }
                  onCheckedChange={setAutomaticBackup}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                The backup takes future runs when the main host is offline for 30 seconds. Runs
                already started stay on their host.
              </p>
              {automaticBackup ? (
                <>
                  <Field label="Backup host">
                    <Select
                      value={backupEnvironmentId}
                      disabled={saving}
                      onValueChange={(id) => {
                        setBackupEnvironmentId(id);
                        setBackupProjectId(null);
                      }}
                    >
                      <SelectTrigger size="sm" aria-label="Backup host">
                        <SelectValue placeholder="Select a connected host">
                          {
                            environments.find(
                              (entry) => entry.environmentId === backupEnvironmentId,
                            )?.label
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {environments
                          .filter((entry) => entry.environmentId !== taskEnvironmentId)
                          .map((entry) => (
                            <SelectItem key={entry.environmentId} value={entry.environmentId}>
                              {entry.label}
                            </SelectItem>
                          ))}
                      </SelectPopup>
                    </Select>
                  </Field>
                  {backupEnvironmentId && backupQuery.data ? (
                    <ScheduledTaskBackupFields
                      key={backupEnvironmentId}
                      environmentId={backupEnvironmentId}
                      projectId={selectedBackupProjectId}
                      onChange={setBackupProjectId}
                    />
                  ) : null}
                  {!taskHostQuery.data?.failoverAvailable ||
                  (backupEnvironmentId && !backupQuery.data?.failoverAvailable) ? (
                    <p className="text-xs text-destructive" role="status">
                      Connect both hosts and link them to T3 Connect before saving automatic backup.
                    </p>
                  ) : null}
                  {!backupModelSelection && backupEnvironmentId ? (
                    <p className="text-xs text-destructive" role="status">
                      The selected model or its options are not available on this backup host.
                      Choose another host or enable the same model in its provider settings.
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    Uses the same branch, model, and effort as above. Times use{" "}
                    {draft.failover?.timeZone ??
                      new Intl.DateTimeFormat().resolvedOptions().timeZone}
                    .
                  </p>
                </>
              ) : null}
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-foreground">Schedule</span>
                <div className="inline-flex items-center gap-0.5 rounded-lg border border-border/70 bg-muted/40 p-0.5">
                  {(
                    [
                      ["fixed", "Daily"],
                      ["interval", "Interval"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={draft.scheduleMode === mode}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                        draft.scheduleMode === mode
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setDraft((current) => ({ ...current, scheduleMode: mode }))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {draft.scheduleMode === "fixed" ? (
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Run at</span>
                    <Input
                      type="time"
                      nativeInput
                      className="w-32"
                      value={draft.timeOfDay}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, timeOfDay: event.target.value }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">on</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAY_ORDER.map((day) => {
                      const selected = draft.weekdays.has(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          aria-pressed={selected}
                          aria-label={WEEKDAY_LABELS[day]}
                          className={cn(
                            "grid size-8 place-items-center rounded-full border text-[11px] font-semibold transition-colors",
                            selected
                              ? "border-primary bg-primary text-primary-foreground shadow-xs"
                              : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                          )}
                          onClick={() =>
                            setDraft((current) => {
                              const weekdays = new Set(current.weekdays);
                              if (weekdays.has(day)) {
                                // Keep at least one day selected: an empty set
                                // would silently persist as a daily schedule.
                                if (weekdays.size === 1) return current;
                                weekdays.delete(day);
                              } else {
                                weekdays.add(day);
                              }
                              return { ...current, weekdays };
                            })
                          }
                        >
                          {WEEKDAY_SHORT[day]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Run every</span>
                  <Input
                    type="number"
                    nativeInput
                    min={1}
                    className="w-24"
                    value={draft.intervalMinutes}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        intervalMinutes: event.target.value,
                      }))
                    }
                  />
                  <span className="text-xs text-muted-foreground">minutes</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-xs font-medium">Enabled</div>
                <div className="text-[11px] text-muted-foreground">
                  Disabled tasks stay saved but do not run.
                </div>
              </div>
              <Switch
                aria-label="Enabled"
                checked={draft.enabled}
                onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
              />
            </div>
          </DialogPanel>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button
              size="sm"
              disabled={saving || editingTaskMissing || openingMainHost}
              onClick={() => void submit()}
            >
              {draft.editingId ? "Save task" : "Create task"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
