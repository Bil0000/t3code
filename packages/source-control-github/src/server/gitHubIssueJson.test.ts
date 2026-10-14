import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { decodeIssueViewerPermissionsJson } from "./gitHubIssueJson.ts";

describe("GitHub issue viewer permissions", () => {
  it.each([
    { role: null, metadata: true },
    { role: undefined, metadata: true },
    { role: "READ", metadata: false },
    { role: "TRIAGE", metadata: true },
    { role: "UNKNOWN", metadata: false },
  ])("keeps metadata permission for role $role separate from issue edits", ({ role, metadata }) => {
    const decoded = decodeIssueViewerPermissionsJson(
      JSON.stringify({
        data: { repository: { viewerPermission: role, issue: { viewerCanUpdate: false } } },
      }),
    );
    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) throw new Error("expected a successful decode");
    expect(decoded.success).toEqual({
      setState: false,
      comment: true,
      edit: false,
      labels: metadata,
      assignees: metadata,
    });
  });
});
