import { useAtomValue } from "@effect/atom-react";
import {
  agentThreadReadAllowed,
  gitHubRoutingConnectionKey,
} from "@t3tools/client-runtime/connection";
import { useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { useAtomCommand } from "~/state/use-atom-command";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { FoldedSettingsSection } from "./FoldedSettingsSection";

export function AgentThreadReadSettings() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const grants = useAtomValue(environmentCatalog.agentThreadReadGrantsValueAtom);
  const update = useAtomCommand(environmentCatalog.setAgentThreadReadGrant);
  const [saving, setSaving] = useState(false);
  const entries = [...catalog.entries.values()];
  if (entries.length < 2) return null;
  return (
    <FoldedSettingsSection
      id="agent-thread-sharing"
      title="Agent thread sharing"
      summary={
        entries.some((source) =>
          entries.some((destination) => agentThreadReadAllowed(source, destination, grants)),
        )
          ? "On"
          : "Off"
      }
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Let agents read projects and threads on another machine while this client is connected. This
        includes thread messages. Agents cannot change that machine through this setting.
      </p>
      {entries.flatMap((source) =>
        entries
          .filter((destination) => destination !== source)
          .map((destination) => {
            const label = `Allow agents on ${source.target.label} to read threads on ${destination.target.label}`;
            return (
              <div
                key={JSON.stringify([
                  source.target.environmentId,
                  destination.target.environmentId,
                ])}
                className="flex items-center justify-between gap-4 px-3 py-2.5 sm:px-4"
              >
                <span className="text-sm">{label}</span>
                <Switch
                  aria-label={label}
                  checked={agentThreadReadAllowed(source, destination, grants)}
                  disabled={
                    !catalog.isReady ||
                    saving ||
                    gitHubRoutingConnectionKey(source) === null ||
                    gitHubRoutingConnectionKey(destination) === null
                  }
                  onCheckedChange={(allowed) => {
                    setSaving(true);
                    void update({
                      sourceEnvironmentId: source.target.environmentId,
                      destinationEnvironmentId: destination.target.environmentId,
                      allowed,
                    }).then((result) => {
                      setSaving(false);
                      if (result._tag === "Failure")
                        toastManager.add({
                          type: "error",
                          title: "Could not save agent thread sharing",
                        });
                    });
                  }}
                />
              </div>
            );
          }),
      )}
    </FoldedSettingsSection>
  );
}
