import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PreviewServerBrowserInstallation } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";

import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

export const SERVER_BROWSER_INSTALL_REQUEST_FAILED =
  "Could not start the install. Check this environment and try again.";

export function serverBrowserInstallationStatus(
  installation: PreviewServerBrowserInstallation,
): string {
  switch (installation.state) {
    case "installed":
      return `Installed · v${installation.version}`;
    case "installing":
      return installation.stage === "browser"
        ? "Installing Chromium…"
        : "Installing browser runtime…";
    case "failed":
      return installation.error?.message ?? "Install failed.";
    case "not-installed":
      return "Not installed · About 300 MB";
  }
}

export function useServerBrowserInstallation(environmentId: EnvironmentId) {
  const result = useAtomValue(
    previewEnvironment.serverBrowserInstallation({ environmentId, input: {} }),
  );
  const installCommand = useAtomCommand(previewEnvironment.serverBrowserInstall);
  const [requesting, setRequesting] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  const installation = AsyncResult.isSuccess(result) ? result.value : null;
  const install = async () => {
    setRequesting(true);
    setRequestFailed(false);
    try {
      const outcome = await installCommand({ environmentId, input: {} });
      setRequestFailed(outcome._tag === "Failure");
    } finally {
      setRequesting(false);
    }
  };
  return {
    installation,
    statusFailed: result._tag === "Failure",
    requestFailed,
    installing: requesting || installation?.state === "installing",
    install,
  };
}
