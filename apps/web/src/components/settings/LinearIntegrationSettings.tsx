import { useState } from "react";

import { usePrimaryEnvironment } from "~/state/environments";
import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";

import { LinearIcon } from "../Icons";
import { LinearConnectionDialog } from "../issue/LinearConnectionDialog";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function LinearIntegrationSettings() {
  const environment = usePrimaryEnvironment();
  const supported = environment?.serverConfig?.environment.capabilities.issues === true;
  const [open, setOpen] = useState(false);
  const invalidate = useAtomCommand(issueEnvironment.invalidate);

  return (
    <SettingsSection id="linear" title="Issue Tracking">
      <SettingsRow
        title="Accounts and project teams"
        description={
          supported
            ? "Connect Linear to browse and work on issues. Manage API keys, accounts, and the team linked to each project."
            : "Connect to a server that supports issues to set up Linear."
        }
        control={
          <Button variant="outline" disabled={!supported} onClick={() => setOpen(true)}>
            <LinearIcon className="size-4" />
            Configure Linear
          </Button>
        }
      />
      {open && supported && environment ? (
        <LinearConnectionDialog
          open={open}
          onOpenChange={setOpen}
          onProviderChanged={() =>
            void invalidate({ environmentId: environment.environmentId, input: {} })
          }
        />
      ) : null}
    </SettingsSection>
  );
}
