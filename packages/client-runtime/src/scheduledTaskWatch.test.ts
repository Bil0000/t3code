import type { ScheduledTask, ScheduledTaskWatch } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  watchActivityLabel,
  watchRuleLabel,
  watchSourceLabel,
  watchStatus,
  type ScheduledTaskWithWatch,
} from "./scheduledTaskWatch.ts";

const watch: ScheduledTaskWatch = {
  source: { type: "jira", baseUrl: "https://acme.atlassian.net", jql: "project = SECRET" },
  filters: [],
  maxConcurrentRuns: 1,
  initializedAt: "2026-10-21T10:00:00.000Z",
  lastFiredAt: null,
  fireCount: 0,
  pendingCount: 0,
  activeRunCount: 0,
};

const task = (patch: Partial<ScheduledTask>, watchPatch: Partial<ScheduledTaskWatch> = {}) =>
  ({
    enabled: true,
    lastRunStatus: "succeeded",
    ...patch,
    watch: { ...watch, ...watchPatch },
  }) as ScheduledTaskWithWatch;

describe("watchSourceLabel", () => {
  it("shows only the host, never the JQL, path, or query", () => {
    expect(watchSourceLabel(watch.source)).toBe("Jira · acme.atlassian.net");
    expect(
      watchSourceLabel({
        type: "http_json",
        url: "https://ci.example.com:8443/private/jobs?team=payroll",
        itemsPath: "jobs",
        keyPath: "id",
      }),
    ).toBe("JSON feed · ci.example.com:8443");
    expect(
      watchSourceLabel({ type: "http_json", url: "not a url", itemsPath: "", keyPath: "id" }),
    ).toBe("JSON feed");
  });
});

describe("watchRuleLabel", () => {
  it("names the first filter and counts the rest", () => {
    expect(watchRuleLabel([])).toBe("Any new item");
    expect(
      watchRuleLabel([
        { path: "fields.status.name", op: "in", value: ["Done", "Closed"] },
        { path: "fields.assignee", op: "exists" },
        { path: "key", op: "startsWith", value: "OPS-" },
      ]),
    ).toBe("fields.status.name is one of Done, Closed +2 more");
    expect(watchRuleLabel([{ path: "fields.assignee", op: "exists" }])).toBe(
      "fields.assignee exists",
    );
  });
});

describe("watchStatus", () => {
  it("puts pause before failure, and failure before baseline", () => {
    expect(watchStatus(task({ enabled: false, lastRunStatus: "failed" })).label).toBe("Paused");
    expect(watchStatus(task({ lastRunStatus: "failed" }, { initializedAt: null })).label).toBe(
      "Check failed",
    );
    expect(watchStatus(task({ lastRunStatus: "never" }, { initializedAt: null })).label).toBe(
      "Setting baseline",
    );
    expect(watchStatus(task({})).label).toBe("Watching");
  });
});

describe("watchActivityLabel", () => {
  it("lists running and queued work only when present", () => {
    expect(watchActivityLabel(watch)).toBe("0 runs started");
    expect(
      watchActivityLabel({
        ...watch,
        maxConcurrentRuns: 2,
        activeRunCount: 2,
        pendingCount: 3,
        fireCount: 1,
      }),
    ).toBe("2 of 2 running · 3 queued · 1 run started");
  });
});
