import { describe, expect, it } from "vite-plus/test";
import { applyPullRequestDraftFilterChange, parsePullRequestQuery } from "./pullRequestQuery.ts";

describe("quoted commas in PR qualifier lists", () => {
  it.each([
    ['label:"needs,triage",wip', { labels: [["needs,triage", "wip"]] }],
    [
      'label:wip,"needs,triage","needs design"',
      { labels: [["wip", "needs,triage", "needs design"]] },
    ],
    ['-label:"needs,triage",wip', { excludedLabels: ["needs,triage", "wip"] }],
    ['area:"web,mobile",server', { labels: [["area:web,mobile", "area:server"]] }],
  ])("keeps quoted names whole in %s", (query, filters) => {
    expect(parsePullRequestQuery(query)).toEqual({ text: "", filters });
  });
});

describe("changing the draft menu after typing a qualifier", () => {
  it.each([
    [
      'draft:false fix label:"needs design"',
      {},
      { draft: "only" },
      'fix label:"needs design"',
      { draft: "only" },
    ],
    [
      'DRAFT:true fix draft:"false"',
      { draft: "only", author: "octocat" },
      { author: "octocat" },
      "fix",
      { author: "octocat" },
    ],
    [
      "draft:false fix",
      { draft: "only" },
      { draft: "hide", checks: "passing" },
      "draft:false fix",
      { draft: "only", checks: "passing" },
    ],
    [
      '"draft:false" draft:maybe -draft:true',
      {},
      { draft: "hide" },
      '"draft:false" draft:maybe -draft:true',
      { draft: "hide" },
    ],
  ] as const)("applies menu changes to %s", (raw, previous, next, query, filters) => {
    expect(applyPullRequestDraftFilterChange(raw, previous, next)).toEqual({ query, filters });
  });
});
