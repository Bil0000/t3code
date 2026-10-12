import { describe, expect, it } from "vite-plus/test";
import { NodeId, ProviderDriverKind, RunId, ThreadId } from "@t3tools/contracts";

import {
  resolveSubagentRowPresentation,
  resolveSubagentStopTarget,
  workflowGroupSummary,
} from "./threadAgentsPresentation";

const base = {
  title: null,
  prompt: "Audit the timestamps",
  status: "running" as const,
  result: null,
  childThreadId: "thread-child" as never,
};

describe("resolveSubagentRowPresentation", () => {
  it("leads with progress while the agent is working", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      progress: "Reading files",
      result: "stale result",
    });

    expect(row.detail).toBe("Reading files");
    expect(row.tone).toBe("working");
    expect(row.live).toBe(true);
  });

  it("leads with the result once the agent has settled", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      status: "completed",
      progress: "Reading files",
      result: "Found two\n  problems",
    });

    expect(row.detail).toBe("Found two problems");
    expect(row.tone).toBe("completed");
    expect(row.statusLabel).toBe("Completed");
  });

  it("shows a failure's text, since that is where the error lands", () => {
    const row = resolveSubagentRowPresentation({ ...base, status: "failed", result: "Timed out" });

    expect(row.detail).toBe("Timed out");
    expect(row.tone).toBe("failed");
  });

  it("falls back to a trimmed prompt when the agent has no title", () => {
    const long = resolveSubagentRowPresentation({ ...base, prompt: "x".repeat(200) });
    const titled = resolveSubagentRowPresentation({ ...base, title: "Subagent: /root/my_worker" });

    expect(long.title).toHaveLength(80);
    expect(long.title.endsWith("...")).toBe(true);
    expect(titled.title).toBe("My Worker");
  });

  it("only offers a thread to open when the agent has one", () => {
    expect(resolveSubagentRowPresentation(base).canOpenThread).toBe(true);
    expect(resolveSubagentRowPresentation({ ...base, childThreadId: null }).canOpenThread).toBe(
      false,
    );
  });

  it("uses the status label when there is nothing to report yet", () => {
    const row = resolveSubagentRowPresentation({ ...base, status: "pending" });

    expect(row.detail).toBeNull();
    expect(row.statusLabel).toBe("Working");
  });

  it("bounds long result previews without dropping the agent's status", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      status: "failed",
      result: "x".repeat(400),
    });
    expect(row.detail).toBe(`${"x".repeat(280)}…`);
    expect(row.statusLabel).toBe("Failed");
  });
});

type Group = Parameters<typeof workflowGroupSummary>[0];

const members = (...statuses: ReadonlyArray<string>) => statuses.map((status) => ({ status }));

describe("workflowGroupSummary", () => {
  it("summarizes phases and settled agents", () => {
    const group = {
      phases: [{ members: members("completed", "failed") }, { members: [] }],
      unphasedMembers: members("running"),
    } as unknown as Group;
    expect(workflowGroupSummary(group)).toBe("1 phase · 2/3 agents done");
    expect(workflowGroupSummary({ phases: [], unphasedMembers: [] } as unknown as Group)).toBe(
      "No agents yet",
    );
  });
});

const stopAgent = {
  id: NodeId.make("agent"),
  threadId: ThreadId.make("parent"),
  childThreadId: ThreadId.make("child"),
  status: "running" as const,
  origin: "app_owned" as const,
  driver: ProviderDriverKind.make("codex"),
  runId: RunId.make("run"),
  nativeTaskRef: null,
};

describe("resolveSubagentStopTarget", () => {
  it.each(["pending", "running", "waiting"] as const)(
    "interrupts only the child of an app-owned %s agent",
    (status) => {
      expect(resolveSubagentStopTarget({ ...stopAgent, status })).toEqual({
        kind: "subagent",
        input: { threadId: stopAgent.childThreadId },
      });
      expect(resolveSubagentStopTarget({ ...stopAgent, status, childThreadId: null })).toBeNull();
    },
  );

  it.each(["idle", "completed", "failed", "cancelled", "interrupted"] as const)(
    "offers no Stop for a %s agent",
    (status) => {
      expect(resolveSubagentStopTarget({ ...stopAgent, status })).toBeNull();
    },
  );

  const native = {
    ...stopAgent,
    origin: "provider_native" as const,
    driver: ProviderDriverKind.make("claudeAgent"),
    childThreadId: null,
    nativeTaskRef: {
      driver: ProviderDriverKind.make("claudeAgent"),
      strength: "strong" as const,
      nativeId: "native-task",
    },
  };

  it("targets a supported native task without interrupting its parent run", () => {
    expect(resolveSubagentStopTarget(native)).toEqual({
      kind: "subagent",
      input: { threadId: native.threadId, subagentId: native.id },
    });
  });

  it("hides native Stop when the task cannot be identified or stopped", () => {
    expect(resolveSubagentStopTarget({ ...native, nativeTaskRef: null })).toBeNull();
    expect(
      resolveSubagentStopTarget({
        ...native,
        nativeTaskRef: { ...native.nativeTaskRef, strength: "weak" },
      }),
    ).toBeNull();
    expect(
      resolveSubagentStopTarget({
        ...native,
        nativeTaskRef: { ...native.nativeTaskRef, nativeId: null },
      }),
    ).toBeNull();
    expect(resolveSubagentStopTarget({ ...native, runId: null })).toBeNull();
    expect(resolveSubagentStopTarget({ ...native, status: "completed" })).toBeNull();
    expect(
      resolveSubagentStopTarget({ ...native, driver: ProviderDriverKind.make("codex") }),
    ).toBeNull();
  });

  it("stops the whole workflow through its own command", () => {
    const workflow = { name: "Review", phases: [], agents: [] };
    expect(resolveSubagentStopTarget({ ...native, workflow })).toEqual({
      kind: "workflow",
      input: { threadId: native.threadId, subagentId: native.id },
    });
    expect(resolveSubagentStopTarget({ ...native, workflow, status: "waiting" })).toBeNull();
    expect(resolveSubagentStopTarget({ ...stopAgent, workflow })).toBeNull();
    expect(resolveSubagentStopTarget({ ...native, workflow, nativeTaskRef: null })).toBeNull();
    expect(
      resolveSubagentStopTarget({
        ...native,
        workflow,
        nativeTaskRef: { ...native.nativeTaskRef, nativeId: "" },
      }),
    ).toBeNull();
  });
});
