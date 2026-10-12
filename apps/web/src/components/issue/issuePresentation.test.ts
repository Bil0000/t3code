import { expect, it } from "vite-plus/test";

import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

import { getIssueProviderPresentation } from "./issuePresentation";

it("presents a source control host's issues as that host", () => {
  const forgejo = getSourceControlPresentationForKind("forgejo");
  expect(getIssueProviderPresentation("forgejo")).toMatchObject({
    providerName: forgejo.providerName,
    Icon: forgejo.Icon,
  });
  expect(getIssueProviderPresentation("jira").providerName).toBe("jira");
});
