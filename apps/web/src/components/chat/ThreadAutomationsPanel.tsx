import { useAtomValue } from "@effect/atom-react";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  EyeIcon,
  EyeOffIcon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  Settings2Icon,
} from "lucide-react";
import { useState } from "react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  isWatchTask,
  watchActivityLabel,
  watchRuleLabel,
  watchSourceLabel,
  watchStatus,
  type WatchStatusTone,
} from "@t3tools/client-runtime/scheduled-task-watch";

import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { cn } from "../../lib/utils";
import { ScheduledRelativeLabel, scheduleLabel } from "../settings/ScheduledTasksSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { requestConfirmDialog } from "../../confirmDialog";
import { RelativeTime } from "../RelativeTime";

import { readEnvironmentScope } from "../../state/session";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

const STATUS_DOT_CLASS: Record<ScheduledTask["lastRunStatus"], string> = {
  never: "bg-muted-foreground/40",
  running: "bg-sky-500",
  succeeded: "bg-emerald-500",
  failed: "bg-destructive",
};

const WATCH_DOT_CLASS: Record<WatchStatusTone, string> = {
  muted: "bg-muted-foreground/40",
  info: "bg-sky-500",
  success: "bg-emerald-500",
  error: "bg-destructive",
};

function taskScheduleLine(task: ScheduledTask) {
  return (
    <>
      {scheduleLabel(task.schedule)}
      {task.enabled && task.nextRunAt !== null ? (
        <>
          {" · next "}
          <ScheduledRelativeLabel value={task.nextRunAt} />
        </>
      ) : task.enabled ? (
        ""
      ) : (
        " · paused"
      )}
    </>
  );
}

export function ThreadAutomationsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(props.environmentId),
  );
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "thread automation toggle",
  });
  const runTaskNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "thread automation run now",
  });
  const deleteTask = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "thread automation stop watching",
  });
  const navigate = useNavigate();
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const boundTasks = (tasksQuery.data?.tasks ?? []).filter(
    (task) => task.threadId === props.threadId,
  );

  if (tasksQuery.error === null && boundTasks.length === 0) return null;

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const toggleEnabled = async (task: ScheduledTask, enabled: boolean) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyTaskId(task.id);
    // Partial update: only the enabled flag changes, so a toggle can never
    // revert concurrent edits made to the task elsewhere.
    const result = await setTaskEnabled({
      environmentId: props.environmentId,
      input: { id: task.id, enabled },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not update automation", squashAtomCommandFailure(result));
    }
  };

  const runNow = async (task: ScheduledTask) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyTaskId(task.id);
    const result = await runTaskNow({
      environmentId: props.environmentId,
      input: { id: task.id },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not run automation", squashAtomCommandFailure(result));
    }
  };

  const stopWatching = async (task: ScheduledTask) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const confirmed =
      (await requestConfirmDialog(`Stop watching?\n${task.title} will be deleted.`, {
        variant: "destructive",
      })) ?? window.confirm(`Stop watching? ${task.title} will be deleted.`);
    if (!confirmed || !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope))
      return;
    setBusyTaskId(task.id);
    const result = await deleteTask({
      environmentId: props.environmentId,
      input: { id: task.id },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not stop watcher", squashAtomCommandFailure(result));
    }
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-automations-heading"
      title="Automations"
      data-thread-automations-panel
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-label="Manage scheduled tasks"
                onClick={() =>
                  void navigate({
                    to: "/settings/scheduled-tasks",
                    search: { environmentId: props.environmentId },
                  })
                }
              >
                <Settings2Icon className="size-3.5" />
              </ThreadDetailsControl>
            }
          />
          <TooltipPopup>Manage scheduled tasks</TooltipPopup>
        </Tooltip>
      }
    >
      {tasksQuery.error !== null ? (
        <p className="px-2.5 py-1.5 text-2xs text-destructive">
          Could not load automations: {tasksQuery.error}
        </p>
      ) : null}

      <ul className="m-0 list-none p-0">
        {boundTasks.map((task) => {
          const watch = isWatchTask(task);
          const line = watch
            ? `${watchStatus(task).label} · ${watchSourceLabel(task.watch.source)}`
            : taskScheduleLine(task);
          const Icon = watch ? EyeIcon : CalendarClockIcon;
          return (
            <li
              key={task.id}
              className={cn(
                "group flex items-center rounded-lg py-1.5",
                THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
              )}
            >
              <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
                <Icon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                <span
                  className={cn(
                    "absolute -right-1 -top-1 size-1.5 rounded-full",
                    watch
                      ? WATCH_DOT_CLASS[watchStatus(task).tone]
                      : STATUS_DOT_CLASS[task.lastRunStatus],
                  )}
                  aria-hidden
                />
              </span>
              <Tooltip>
                <TooltipTrigger render={<div className="min-w-0 flex-1" />}>
                  <span className="block truncate text-sm font-medium text-foreground/80">
                    {task.title}
                  </span>
                  <p
                    className={cn(
                      "truncate text-2xs",
                      watch && watchStatus(task).tone === "error"
                        ? "text-destructive"
                        : "text-muted-foreground",
                    )}
                  >
                    {line}
                  </p>
                </TooltipTrigger>
                <TooltipPopup side="left" className={watch ? "max-w-72" : undefined}>
                  <p className="font-medium">{task.title}</p>
                  <p className="text-muted-foreground">{line}</p>
                  {watch ? (
                    <>
                      <p className="text-muted-foreground">{watchRuleLabel(task.watch.filters)}</p>
                      <p className="text-muted-foreground">
                        {task.lastRunAt ? (
                          <>
                            {"Checked "}
                            <RelativeTime timestamp={task.lastRunAt} />
                            {" · "}
                          </>
                        ) : null}
                        {watchActivityLabel(task.watch)}
                      </p>
                      {task.lastRunError ? (
                        <p className="text-destructive">{task.lastRunError}</p>
                      ) : null}
                    </>
                  ) : null}
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ThreadDetailsControl
                      size="icon-xs"
                      variant="ghost"
                      part="icon"
                      aria-label={watch ? `Stop watching ${task.title}` : `Edit ${task.title}`}
                      disabled={watch && (!canOperate || busyTaskId !== null)}
                      onClick={() =>
                        watch
                          ? void stopWatching(task)
                          : void navigate({
                              to: "/settings/scheduled-tasks",
                              search: { environmentId: props.environmentId, taskId: task.id },
                            })
                      }
                    >
                      {watch ? (
                        <EyeOffIcon className="size-3.5" />
                      ) : (
                        <PencilIcon className="size-3.5" />
                      )}
                    </ThreadDetailsControl>
                  }
                />
                <TooltipPopup>{watch ? "Stop watching" : "Edit automation"}</TooltipPopup>
              </Tooltip>
              {/* A webhook task runs from its URL; there is no request to run it with. */}
              {task.schedule.type === "webhook" ? null : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <ThreadDetailsControl
                        size="icon-xs"
                        variant="ghost"
                        part="icon"
                        aria-label={watch ? `Check ${task.title} now` : `Run ${task.title} now`}
                        disabled={
                          !canOperate ||
                          busyTaskId !== null ||
                          task.lastRunStatus === "running" ||
                          (watch && !task.enabled)
                        }
                        onClick={() => void runNow(task)}
                      >
                        {watch ? (
                          <RefreshCwIcon className="size-3.5" />
                        ) : (
                          <PlayIcon className="size-3.5" />
                        )}
                      </ThreadDetailsControl>
                    }
                  />
                  <TooltipPopup>{watch ? "Check now" : "Run now"}</TooltipPopup>
                </Tooltip>
              )}
              <Switch
                checked={task.enabled}
                disabled={!canOperate || busyTaskId !== null}
                aria-label={task.enabled ? `Pause ${task.title}` : `Resume ${task.title}`}
                onCheckedChange={(enabled) => void toggleEnabled(task, enabled)}
              />
            </li>
          );
        })}
      </ul>
    </ThreadDetailsSection>
  );
}
