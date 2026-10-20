import { useAtomValue } from "@effect/atom-react";
import {
  agentThreadReadAllowed,
  gitHubRoutingConnectionKey,
} from "@t3tools/client-runtime/connection";
import { useState } from "react";
import { View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { AppText } from "../../components/ui/AppText";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

export function AgentThreadReadSettings() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const grants = useAtomValue(environmentCatalog.agentThreadReadGrantsValueAtom);
  const update = useAtomCommand(environmentCatalog.setAgentThreadReadGrant);
  const [saving, setSaving] = useState(false);
  const entries = [...catalog.entries.values()];
  if (entries.length < 2) return null;
  return (
    <View className="mt-5 gap-3">
      <SettingsSection title="Agent thread sharing">
        {entries.flatMap((source) =>
          entries
            .filter((destination) => destination !== source)
            .map((destination) => (
              <ListToggleRow
                key={JSON.stringify([
                  source.target.environmentId,
                  destination.target.environmentId,
                ])}
                label={`Allow agents on ${source.target.label} to read threads on ${destination.target.label}`}
                value={agentThreadReadAllowed(source, destination, grants)}
                disabled={
                  !catalog.isReady ||
                  saving ||
                  gitHubRoutingConnectionKey(source) === null ||
                  gitHubRoutingConnectionKey(destination) === null
                }
                onValueChange={(allowed) => {
                  setSaving(true);
                  void update({
                    sourceEnvironmentId: source.target.environmentId,
                    destinationEnvironmentId: destination.target.environmentId,
                    allowed,
                  }).then((result) => {
                    setSaving(false);
                    if (result._tag === "Failure")
                      Dialog.alert(
                        "Could not save agent thread sharing",
                        "Try again before leaving this screen.",
                      );
                  });
                }}
              />
            )),
        )}
      </SettingsSection>
      <AppText className="px-2 text-sm text-foreground-muted">
        Share projects, threads, and messages while this client is connected. Agents cannot change
        the other machine through this setting.
      </AppText>
    </View>
  );
}
