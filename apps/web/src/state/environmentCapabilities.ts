import type { ServerConfig } from "@t3tools/contracts";

/** Missing is the version-skew case: older environments must never be probed for these APIs. */
export function serverSupportsPullRequests(serverConfig: ServerConfig | null | undefined): boolean {
  return serverConfig?.environment.capabilities.pullRequests === true;
}
