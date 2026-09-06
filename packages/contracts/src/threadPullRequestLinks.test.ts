import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "./baseSchemas.ts";
import {
  applyThreadPullRequestUpdate,
  getThreadPullRequest,
  getThreadPullRequestLinks,
  sameThreadPullRequest,
} from "./threadPullRequestLinks.ts";

const reference = {
  projectId: ProjectId.make("project"),
  repository: "owner/repo",
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
};

describe("thread pull request links", () => {
  it("replays legacy source updates without dropping the other association", () => {
    const linked = applyThreadPullRequestUpdate({}, { linkedPullRequest: reference });
    const both = applyThreadPullRequestUpdate(linked, { branchPullRequest: reference });
    const unlinked = applyThreadPullRequestUpdate(both, { linkedPullRequest: null });
    expect(getThreadPullRequestLinks(unlinked)).toEqual([{ ...reference, source: "branch" }]);
    expect(getThreadPullRequest(unlinked)?.number).toBe(1);
  });

  it("uses the collection even when legacy fields disagree or it is empty", () => {
    expect(getThreadPullRequest({ linkedPullRequest: reference, pullRequestLinks: [] })).toBeNull();
    expect(
      getThreadPullRequest({
        linkedPullRequest: reference,
        pullRequestLinks: [
          { ...reference, number: 2, source: "branch" },
          { ...reference, number: 3, source: "linked" },
        ],
      })?.number,
    ).toBe(3);
  });

  it("matches repository identity without treating a changed URL as a different PR", () => {
    expect(
      sameThreadPullRequest(reference, {
        ...reference,
        repository: "OWNER/REPO",
        url: `${reference.url}/files`,
      }),
    ).toBe(true);
    expect(
      sameThreadPullRequest(reference, { ...reference, projectId: ProjectId.make("other") }),
    ).toBe(false);
    expect(sameThreadPullRequest(reference, { ...reference, number: 2 })).toBe(false);
  });
});
