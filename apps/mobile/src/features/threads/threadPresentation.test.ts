import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { resolveThreadStatus } from "./threadPresentation";

const waitingThread = {
  environmentId: EnvironmentId.make("environment-1"),
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Capacity recovery",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  latestUserMessageAt: "2026-01-01T00:00:00.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  session: {
    threadId: ThreadId.make("thread-1"),
    status: "waiting",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
} satisfies EnvironmentThreadShell;

describe("resolveThreadStatus", () => {
  it("shows a capacity recovery as waiting to resume", () => {
    expect(resolveThreadStatus(waitingThread)).toMatchObject({
      kind: "waiting",
      label: "Waiting to resume",
      pulse: false,
    });
  });
});
