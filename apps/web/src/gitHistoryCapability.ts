import type { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";

export function hasGitHistoryCapability(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "gitHistory"> | null | undefined,
): boolean {
  return capabilities?.gitHistory === true;
}
