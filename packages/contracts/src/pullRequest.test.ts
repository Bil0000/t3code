import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { PullRequestListResult } from "./pullRequest.ts";

const decodeListResult = Schema.decodeUnknownSync(PullRequestListResult);

const LIST_RESULT: PullRequestListResult = {
  viewers: { "github.com": "bilal", "gitlab.com": "bilal.hassan" },
  providers: [
    { kind: "github", projectCount: 1, configured: true, detail: null },
    { kind: "gitlab", projectCount: 1, configured: false, detail: "glab is not installed." },
  ],
  entries: [
    {
      provider: "github",
      host: "github.com",
      projectId: "project-1" as PullRequestListResult["entries"][number]["projectId"],
      projectTitle: "t3code",
      repository: "pingdotgg/t3code",
      number: 1,
      title: "Add a pull requests page",
      url: "https://github.com/pingdotgg/t3code/pull/1",
      author: { login: "octocat", name: null, avatarUrl: null },
      headBranch: "feat/page",
      baseBranch: "main",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: 1,
      deletions: 0,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      viewerReviewRequested: false,
      labels: [{ name: "backend", color: null }],
    },
  ],
  errors: [],
  truncated: false,
};

describe("PullRequestListResult", () => {
  /**
   * The RPC builds this codec at call time, so a shape it cannot lower — an open-keyed record
   * with an optional value, for one — fails as an interrupted request rather than as a schema
   * error. Building it here turns that into a test failure instead.
   */
  it("round-trips through the JSON codec the RPC serializes with", () => {
    const codec = Schema.toCodecJson(PullRequestListResult);

    const decoded = Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(LIST_RESULT));

    expect(decoded).toStrictEqual(LIST_RESULT);
  });

  it("keys a viewer by host, so two hosts of one kind stay separate accounts", () => {
    const decoded = decodeListResult({
      ...LIST_RESULT,
      viewers: { "github.com": "bilal", "github.acme.dev": "b.hassan" },
    });

    expect(decoded.viewers["github.com"]).toBe("bilal");
    expect(decoded.viewers["github.acme.dev"]).toBe("b.hassan");
  });
});
