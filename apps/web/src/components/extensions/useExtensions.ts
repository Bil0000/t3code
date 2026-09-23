import type { EnvironmentId, InstalledExtension } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import * as Option from "effect/Option";
import { useCallback } from "react";

import type { ExtensionSurfaceTarget } from "~/rightPanelStore";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { usePreparedConnection } from "~/state/session";

export function extensionHasUi(extension: InstalledExtension): boolean {
  return extension.viewContainers.length > 0 || extension.customEditors.length > 0;
}

export function extensionLaunchTargets(
  extension: InstalledExtension,
): { label: string; target: ExtensionSurfaceTarget }[] {
  if (!extension.enabled || !extensionHasUi(extension)) return [];
  if (extension.viewContainers.length === 0) {
    return [
      { label: extension.displayName, target: { kind: "extension", extensionId: extension.id } },
    ];
  }
  return extension.viewContainers.map((container) => ({
    label:
      extension.viewContainers.length === 1 || container.title === ""
        ? extension.displayName
        : `${extension.displayName}: ${container.title}`,
    target: { kind: "extension", extensionId: extension.id, viewContainerId: container.id },
  }));
}

export function useExtensions(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.extensionsState({ environmentId, input: {} }),
  );
  const httpBaseUrl = Option.getOrNull(usePreparedConnection(environmentId))?.httpBaseUrl ?? null;
  const resolveIconUrl = useCallback(
    (extension: InstalledExtension) =>
      extension.iconUrl && httpBaseUrl ? resolveAssetUrl(httpBaseUrl, extension.iconUrl) : null,
    [httpBaseUrl],
  );
  return { state: query.data, error: query.error, resolveIconUrl };
}
