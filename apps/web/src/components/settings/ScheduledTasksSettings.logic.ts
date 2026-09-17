import type { VcsRef } from "@t3tools/contracts";

export function resolveScheduledTaskBaseRef(
  baseRef: string,
  refs: ReadonlyArray<Pick<VcsRef, "name" | "isDefault">>,
): string {
  return baseRef.trim() || refs.find((ref) => ref.isDefault)?.name || "";
}
