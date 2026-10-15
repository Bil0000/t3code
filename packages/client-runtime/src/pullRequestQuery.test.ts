import { describe, expect, it } from "vite-plus/test";
import { parsePullRequestQuery } from "./pullRequestQuery.ts";

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
