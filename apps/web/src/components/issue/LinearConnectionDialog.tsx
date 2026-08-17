import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { useAtomCommand } from "~/state/use-atom-command";

import { usePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { issueTrackingEnvironment } from "../../state/issueTracking";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { LinearIcon } from "../Icons";
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

const UNMAPPED = "__unmapped__";
export type LinearProviderChange = "available" | "updated" | "unavailable";

export function LinearConnectionDialog({
  open,
  onOpenChange,
  onProviderChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProviderChanged: (change: LinearProviderChange) => void;
}) {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const projectTeams = usePrimarySettings((settings) => settings.issueTracking.linear.projectTeams);
  const connection = useEnvironmentQuery(
    !open || environmentId === null
      ? null
      : issueTrackingEnvironment.linearStatus({ environmentId, input: undefined }),
  );
  const connect = useAtomCommand(issueTrackingEnvironment.linearConnect, { reportFailure: false });
  const disconnect = useAtomCommand(issueTrackingEnvironment.linearDisconnect, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const linear = connection.data;

  async function run<A, E>(action: () => Promise<AtomCommandResult<A, E>>, after: () => void) {
    setBusy(true);
    setActionError(null);
    const commandResult = await action();
    setBusy(false);
    if (commandResult._tag === "Failure") {
      setActionError(formatEnvironmentQueryError(commandResult.cause));
      return;
    }
    after();
  }

  const setProjectTeam = (projectId: (typeof projects)[number]["id"], teamKey: string | null) => {
    if (environmentId === null) return;
    const next = { ...projectTeams };
    if (teamKey === null) delete next[projectId];
    else next[projectId] = teamKey;
    void run(
      () =>
        updateSettings({
          environmentId,
          input: { patch: { issueTracking: { linear: { projectTeams: next } } } },
        }),
      () => {
        const wasAvailable = Object.keys(projectTeams).length > 0;
        const isAvailable = Object.keys(next).length > 0;
        onProviderChanged(
          wasAvailable === isAvailable ? "updated" : isAvailable ? "available" : "unavailable",
        );
      },
    );
  };

  const connected = linear?.status === "authenticated";
  const error = actionError ?? connection.error;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) {
          setActionError(null);
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <LinearIcon className="size-4.5" />
            Linear
          </DialogTitle>
          <DialogDescription>
            {connected
              ? `Connected as ${linear.accountName ?? "Linear account"}${linear.accountEmail ? ` (${linear.accountEmail})` : ""}.`
              : linear?.status === "unverified"
                ? "API key saved. Linear could not verify it."
                : "Connect Linear with a personal API key. The key stays on this server."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (environmentId === null || token.trim().length === 0) return;
              void run(
                () => connect({ environmentId, input: { token: token.trim() } }),
                () => {
                  setToken("");
                  connection.refresh();
                  onProviderChanged(
                    !connected && Object.keys(projectTeams).length > 0 ? "available" : "updated",
                  );
                },
              );
            }}
          >
            <label className="block text-sm font-medium" htmlFor="linear-api-key">
              {connected ? "Replace API key" : "API key"}
            </label>
            <div className="flex gap-2">
              <Input
                id="linear-api-key"
                type="password"
                value={token}
                onChange={(event) => setToken(event.currentTarget.value)}
                placeholder="lin_api_…"
                aria-label={connected ? "Replace Linear API key" : "Linear API key"}
                autoComplete="off"
              />
              <Button type="submit" disabled={busy || token.trim().length === 0}>
                {connected ? "Replace" : "Connect"}
              </Button>
            </div>
          </form>

          {connected ? (
            <div className="space-y-2">
              <div>
                <h3 className="text-sm font-medium">Project teams</h3>
                <p className="text-xs text-muted-foreground">
                  Choose which Linear team appears beside each T3 project.
                </p>
              </div>
              <div className="divide-y divide-border/50">
                {projects.map((project) => {
                  const value = projectTeams[project.id] ?? UNMAPPED;
                  return (
                    <div key={project.id} className="flex items-center justify-between gap-4 py-2">
                      <span className="min-w-0 truncate text-sm">{project.title}</span>
                      <Select
                        value={value}
                        disabled={busy}
                        onValueChange={(next) =>
                          next && setProjectTeam(project.id, next === UNMAPPED ? null : next)
                        }
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-52"
                          aria-label={`Linear team for ${project.title}`}
                        >
                          <SelectValue>{value === UNMAPPED ? "Not connected" : value}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup align="end" alignItemWithTrigger={false}>
                          <SelectItem value={UNMAPPED}>Not connected</SelectItem>
                          {linear.teams.map((team) => (
                            <SelectItem key={team.id} value={team.key}>
                              {team.name} ({team.key})
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </div>
                  );
                })}
                {projects.length === 0 ? (
                  <p className="py-3 text-sm text-muted-foreground">Add a project first.</p>
                ) : null}
              </div>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {linear?.hasStoredToken ? (
            <Button
              variant="destructive-outline"
              className="sm:me-auto"
              disabled={busy || environmentId === null}
              onClick={() =>
                environmentId === null
                  ? undefined
                  : void run(
                      () => disconnect({ environmentId, input: undefined }),
                      () => {
                        setToken("");
                        connection.refresh();
                        onProviderChanged("unavailable");
                      },
                    )
              }
            >
              Disconnect
            </Button>
          ) : null}
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
