import { describe, expect, it } from "vite-plus/test";
import type { NavigationState } from "@react-navigation/native";
import { issueParamsKey, selectedIssueKey } from "./issueSelection";

const params = {
  environmentId: "environment-one",
  projectId: "project-one",
  tracker: "linear",
  host: "Linear.APP",
  scope: "ENG",
  key: "ENG-7",
};
const home = { key: "home", name: "Home" };
const issue = { key: "issue", name: "Issue", params };
function selection(routes: NavigationState["routes"], index = routes.length - 1) {
  return selectedIssueKey({ routes, index });
}

describe("displayed issue selection", () => {
  it("matches the list row key for the same environment and keeps environments and trackers apart", () => {
    expect(selection([home, issue])).toBe(issueParamsKey({ ...params, host: "linear.app" }));
    expect(selection([home, { ...issue, params: { ...params, tracker: "jira" } }])).not.toBe(
      selection([home, issue]),
    );
    expect(
      selection([home, { ...issue, params: { ...params, environmentId: "environment-two" } }]),
    ).not.toBe(selection([home, issue]));
  });

  it("follows the issue beneath its sheets and drops it beneath a later thread", () => {
    expect(selection([home, issue, { key: "compose", name: "IssueCompose", params }])).toBe(
      selection([home, issue]),
    );
    expect(selection([home, issue, { key: "thread", name: "Thread" }])).toBeNull();
    expect(selection([home, issue, { key: "pr", name: "PullRequest" }])).toBeNull();
  });
});
