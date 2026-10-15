import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  IssueActor,
  IssueCandidates,
  IssueCommentsPageInput,
  IssueUpdateInput,
  IssueTemplate,
  IssueTemplatesInput,
  WS_METHODS,
  WsIssuesRpcGroup,
  ProjectId,
  IssueTrackerKind,
  threadIssueKeyOf,
} from "./index.ts";

const decodeActor = Schema.decodeSync(IssueActor);
const decodeCandidates = Schema.decodeSync(IssueCandidates);
const encodeUpdate = Schema.encodeSync(IssueUpdateInput);

it("preserves native actor and label IDs while accepting older name-only data", () => {
  const actor = { login: "Alex", name: null, avatarUrl: null };
  expect(decodeActor(actor)).toEqual(actor);
  expect(decodeActor({ ...actor, id: "account-123" })).toEqual({ ...actor, id: "account-123" });
  const candidates = {
    labels: [
      { name: "Bug", color: null, description: null, id: "label-123" },
      { name: "Old", color: null, description: null },
    ],
    assignees: [],
    truncated: false,
  };
  expect(decodeCandidates(candidates)).toEqual(candidates);
});

it("encodes a full label replacement without dropping an issue's existing labels", () => {
  const input = {
    projectId: ProjectId.make("project-1"),
    tracker: IssueTrackerKind.make("jira"),
    scope: "ENG",
    key: "ENG-1",
    labels: Array.from({ length: 121 }, (_, index) => `label-${index}`),
  };
  expect(encodeUpdate(input)).toEqual(input);
});

it("accepts older comment requests and preserves an optional viewer", () => {
  const decode = Schema.decodeSync(IssueCommentsPageInput);
  const input = {
    projectId: ProjectId.make("project-1"),
    tracker: IssueTrackerKind.make("linear"),
    scope: "ENG",
    key: "ENG-1",
    cursor: "older",
  };
  expect(decode(input)).toEqual(input);
  expect(decode({ ...input, viewer: "account-123" })).toEqual({ ...input, viewer: "account-123" });
  expect(() => decode({ ...input, viewer: " " })).toThrow();
});

it("preserves template selection through its schema and the existing RPC", () => {
  const decodeInput = Schema.decodeUnknownSync(IssueTemplatesInput);
  const decode = Schema.decodeUnknownSync(
    WsIssuesRpcGroup.requests.get(WS_METHODS.issuesTemplates)!.payloadSchema,
  );
  const input = {
    projectId: ProjectId.make("project-1"),
    tracker: IssueTrackerKind.make("gitlab"),
    host: "gitlab.com",
    scope: "acme/web",
  };
  for (const flags of [
    {},
    { metadataOnly: false },
    { metadataOnly: true },
    { templateKey: "Bug" },
    { metadataOnly: false, templateKey: "Bug" },
  ]) {
    const request = { ...input, ...flags };
    expect(decodeInput(request)).toEqual(request);
    expect(decode(request)).toEqual(request);
  }
  expect(() => decodeInput({ ...input, templateKey: " " })).toThrow();
  expect(() => decode({ ...input, templateKey: " " })).toThrow();
});

it("accepts inline and deferred templates while keeping bodies required", () => {
  const decode = Schema.decodeUnknownSync(IssueTemplate);
  const template = {
    key: "Bug",
    name: "Bug",
    about: "",
    title: "",
    body: "",
    labels: [],
    assignees: [],
  };
  expect(decode(template)).toEqual(template);
  for (const contentDeferred of [false, true]) {
    expect(decode({ ...template, contentDeferred })).toEqual({ ...template, contentDeferred });
  }
  expect(() => decode({ ...template, body: undefined, contentDeferred: true })).toThrow();
});

it.each([
  { tracker: "linear", key: "eng-7", canonical: "ENG-7", equal: true },
  { tracker: "jira", key: "ops-7", canonical: "OPS-7", equal: true },
  { tracker: "custom-tracker", key: "eng-7", canonical: "ENG-7", equal: false },
  { tracker: "github", key: "7", canonical: "7", equal: true },
  { tracker: "gitlab", key: "7", canonical: "07", equal: false },
])("matches $tracker keys with their native case rules", ({ tracker, key, canonical, equal }) => {
  const identity = { tracker, host: "example.com", scope: "workspace/team", key: canonical };
  const saved = { tracker, host: " Example.COM ", scope: " Workspace/TEAM ", key: ` ${key} ` };
  expect(threadIssueKeyOf(saved) === threadIssueKeyOf(identity)).toBe(equal);
  expect(threadIssueKeyOf(identity)).not.toBe(
    threadIssueKeyOf({ ...identity, tracker: tracker.toUpperCase() }),
  );
});
