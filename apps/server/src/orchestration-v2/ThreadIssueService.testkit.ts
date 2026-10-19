import type { IssueCapabilities } from "@t3tools/contracts";

export const emptyIssueDetailFields = (states: IssueCapabilities["states"]) => ({
  writable: true,
  capabilities: {
    create: false,
    edit: false,
    comment: false,
    labels: false,
    assignees: false,
    reactions: false,
    templates: false,
    linkedPullRequests: false,
    events: false,
    search: false,
    states,
    closeReasons: [],
  },
  viewerPermissions: {
    setState: false,
    comment: false,
    edit: false,
    labels: false,
    assignees: false,
  },
  viewer: null,
  body: "",
  comments: [],
  commentsCursor: null,
  events: [],
  linkedPullRequests: [],
});
