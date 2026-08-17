import { useState } from "react";
import { useAtomCommand } from "~/state/use-atom-command";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { issueTrackingEnvironment } from "../../state/issueTracking";
import { useEnvironmentQuery } from "../../state/query";
import { LinearIcon } from "../Icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const UNMAPPED = "__unmapped__";

export function IssueTrackingSettingsPanel() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const projectTeams = usePrimarySettings((settings) => settings.issueTracking.linear.projectTeams);
  const updateSettings = useUpdatePrimarySettings();
  const connection = useEnvironmentQuery(
    environmentId === null
      ? null
      : issueTrackingEnvironment.linearStatus({ environmentId, input: undefined }),
  );
  const connect = useAtomCommand(issueTrackingEnvironment.linearConnect);
  const disconnect = useAtomCommand(issueTrackingEnvironment.linearDisconnect);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const linear = connection.data;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      setToken("");
      connection.refresh();
    } finally {
      setBusy(false);
    }
  };

  const setProjectTeam = (projectId: (typeof projects)[number]["id"], teamKey: string | null) => {
    const next = { ...projectTeams };
    if (teamKey === null) delete next[projectId];
    else next[projectId] = teamKey;
    updateSettings({ issueTracking: { linear: { projectTeams: next } } });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("issue-tracking")}
        icon={<LinearIcon className="size-4.5" />}
      >
        <SettingsRow
          title="Linear"
          description={
            linear?.status === "authenticated"
              ? `Connected as ${linear.accountName ?? "Linear account"}${linear.accountEmail ? ` (${linear.accountEmail})` : ""}.`
              : linear?.status === "unverified"
                ? "Token saved. Linear could not be reached to verify it."
                : "Use a Linear personal API key. The key stays on this server."
          }
          status={connection.error}
          control={
            linear?.status === "authenticated" || linear?.hasStoredToken ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(() => disconnect({ environmentId: environmentId!, input: undefined }))
                }
              >
                Disconnect
              </Button>
            ) : null
          }
        >
          {linear?.status !== "authenticated" ? (
            <form
              className="flex max-w-xl gap-2 px-0 py-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (environmentId === null || token.trim().length === 0) return;
                void run(() => connect({ environmentId, input: { token: token.trim() } }));
              }}
            >
              <Input
                type="password"
                value={token}
                onChange={(event) => setToken(event.currentTarget.value)}
                placeholder="lin_api_…"
                aria-label="Linear API key"
                autoComplete="off"
              />
              <Button type="submit" disabled={busy || token.trim().length === 0}>
                Connect
              </Button>
            </form>
          ) : null}
        </SettingsRow>

        {linear?.status === "authenticated" ? (
          <SettingsRow
            title="Project teams"
            description="Choose which Linear team appears beside each T3 project."
          >
            <div className="divide-y divide-border/50">
              {projects.map((project) => {
                const value = projectTeams[project.id] ?? UNMAPPED;
                return (
                  <div key={project.id} className="flex items-center justify-between gap-4 py-2">
                    <span className="min-w-0 truncate text-sm">{project.title}</span>
                    <Select
                      value={value}
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
          </SettingsRow>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
