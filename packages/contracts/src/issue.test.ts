import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AuthOrchestrationReadScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS, WsIssuesRpcGroup } from "./rpc.ts";
import { ProjectId } from "./baseSchemas.ts";
import {
  IssueActor,
  IssueCandidatesInput,
  IssueCommentsPageInput,
  ThreadIssueLink,
  IssueLabelCandidatesPage,
  IssueState,
  IssuePageInput,
  IssueHierarchyPage,
  IssueTemplate,
  IssueTemplateList,
  IssueTemplatesInput,
  IssueScopeRef,
  IssueCapabilities,
  IssueCreateInput,
  IssueCreateResult,
  IssueLinkedPullRequest,
  IssueResolveUrlInput,
  IssueResolvedUrl,
  IssueSummary,
  IssueTrackerKind,
  issueListCursorKey,
  threadIssueKeyOf,
  threadIssueKeysEqual,
  IssueTrackerProjectBinding,
  StandaloneIssueTrackerDescriptor,
} from "./issue.ts";

const decodeDescriptor = Schema.decodeEffect(StandaloneIssueTrackerDescriptor);
const decodeComments = Schema.decodeUnknownSync(IssueCommentsPageInput);
const decodeThreadLink = Schema.decodeUnknownSync(ThreadIssueLink);
const decodeActor = Schema.decodeEffect(IssueActor);
const decodeCreate = Schema.decodeEffect(IssueCreateInput);
const decodeCreated = Schema.decodeEffect(IssueCreateResult);
const decodeBinding = Schema.decodeEffect(IssueTrackerProjectBinding);
const decodeState = Schema.decodeUnknownSync(IssueState);
const decodePage = Schema.decodeUnknownSync(IssuePageInput);
const decodeHierarchy = Schema.decodeUnknownSync(IssueHierarchyPage);
const decodeTemplate = Schema.decodeUnknownSync(IssueTemplate);
const decodeTemplates = Schema.decodeUnknownSync(IssueTemplateList);
const decodeLabelPage = Schema.decodeUnknownSync(IssueLabelCandidatesPage);
const decodeResolveInput = Schema.decodeSync(IssueResolveUrlInput);
const decodeResolved = Schema.decodeSync(IssueResolvedUrl);
const decodeTemplateInput = Schema.decodeSync(IssueTemplatesInput);
const decodeTemplateRpc = Schema.decodeUnknownSync(
  WsIssuesRpcGroup.requests.get(WS_METHODS.issuesTemplates)!.payloadSchema,
);
const decodeScope = Schema.decodeUnknownSync(IssueScopeRef);

it("preserves optional native reactions on issue summaries", () => {
  const decode = Schema.decodeUnknownSync(IssueSummary);
  const summary = {
    tracker: "linear",
    host: "linear.app",
    scope: "ENG",
    key: "ENG-7",
    displayKey: "ENG-7",
    title: "Issue",
    url: "https://linear.app/team/issue/ENG-7/issue",
    author: null,
    state: { name: "Open", category: "open" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: null,
  };
  expect(decode(summary)).toEqual(summary);
  const reactions = [{ content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true }];
  expect(decode({ ...summary, reactions, reactionsTruncated: true })).toEqual({
    ...summary,
    reactions,
    reactionsTruncated: true,
  });
  expect(() => decode({ ...summary, reactions: [{ ...reactions[0], count: 0 }] })).toThrow();
});

it("carries an optional native key through the existing candidates RPC", () => {
  const decodeInput = Schema.decodeSync(IssueCandidatesInput);
  const decode = Schema.decodeUnknownSync(
    WsIssuesRpcGroup.requests.get(WS_METHODS.issuesCandidates)!.payloadSchema,
  );
  const scope = {
    projectId: ProjectId.make("project-1"),
    tracker: IssueTrackerKind.make("jira"),
    host: "jira.example.com",
    scope: "OPS",
  };
  for (const selection of [{}, { key: "OPS-7" }]) {
    const input = { ...scope, ...selection };
    expect(decodeInput(input)).toEqual(input);
    expect(decode(input)).toEqual(input);
  }
  for (const key of ["", "  ", null, 7]) {
    expect(() => decode({ ...scope, key })).toThrow();
  }
});

it("accepts older reaction capabilities and preserves native comment limits", () => {
  const decode = Schema.decodeUnknownSync(IssueCapabilities);
  const capabilities = {
    create: true,
    edit: true,
    comment: true,
    labels: true,
    assignees: true,
    reactions: true,
    templates: false,
    linkedPullRequests: true,
    events: true,
    search: true,
    states: [],
    closeReasons: [],
  };
  expect(decode(capabilities)).toEqual(capabilities);
  const native = {
    ...capabilities,
    reactions: false,
    commentReactions: true,
    reactionContents: ["thumbs-up", "thumbs-down", "heart", "hooray", "laugh", "confused"],
  };
  expect(decode(native)).toEqual(native);
  expect(() => decode({ ...native, reactionContents: ["like"] })).toThrow();
  expect(() => decode({ ...native, reactionContents: Array(9).fill("heart") })).toThrow();
});

it("keeps unknown comment totals nullable and known totals non-negative integers", () => {
  const decode = Schema.decodeUnknownSync(IssueSummary.fields.commentCount);
  expect(decode(null)).toBeNull();
  expect(decode(0)).toBe(0);
  expect(decode(101)).toBe(101);
  expect(() => decode(-1)).toThrow();
  expect(() => decode(1.5)).toThrow();
  expect(Schema.toJsonSchemaDocument(IssueSummary.fields.commentCount).schema).toMatchObject({
    anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
  });
});

it("accepts unknown linked pull request states while preserving known states", () => {
  const decode = Schema.decodeUnknownSync(IssueLinkedPullRequest.fields.state);
  for (const state of [null, "open", "closed", "merged"]) {
    expect(decode(state)).toBe(state);
  }
  expect(() => decode("unknown")).toThrow();
});

it.effect("decodes a tracker that needs a site and several credential fields", () =>
  Effect.gen(function* () {
    const descriptor = {
      tracker: IssueTrackerKind.make("jira"),
      displayName: "Jira",
      host: null,
      scopeNoun: "project",
      credential: {
        label: "API token",
        helpUrl: null,
        fields: [
          { key: "site", label: "Site", secret: false },
          { key: "email", label: "Email", secret: false },
          { key: "token", label: "API token", secret: true },
        ],
      },
    };
    assert.deepEqual(yield* decodeDescriptor(descriptor), descriptor);
  }),
);

it.effect("keeps native actor identifiers distinct from their visible login", () =>
  Effect.gen(function* () {
    const actor = { login: "Alex", id: "account-123", name: null, avatarUrl: null };
    assert.deepEqual(yield* decodeActor(actor), actor);
  }),
);

it.effect("preserves the selected native issue type on create", () =>
  Effect.gen(function* () {
    const input = {
      projectId: ProjectId.make("project-1"),
      tracker: IssueTrackerKind.make("jira"),
      scope: "ENG",
      title: "Fix",
      body: "",
      labels: [],
      assignees: [],
      issueType: "10001",
    };
    assert.deepEqual(yield* decodeCreate(input), input);
  }),
);

it.effect("retains a binding's real site and accepts older fixed-host bindings", () =>
  Effect.gen(function* () {
    const binding = {
      tracker: IssueTrackerKind.make("jira"),
      scope: "ENG",
      host: "example.atlassian.net",
    };
    assert.deepEqual(yield* decodeBinding(binding), binding);
    const old = { tracker: IssueTrackerKind.make("linear"), scope: "ENG" };
    assert.deepEqual(yield* decodeBinding(old), old);
  }),
);

it.effect("preserves a created issue and warnings about native fields that were skipped", () =>
  Effect.gen(function* () {
    const created = {
      key: "42",
      displayKey: "#42",
      url: "https://forgejo.example/acme/web/issues/42",
      warnings: ["The issue was created, but the host did not apply the selected labels."],
    };
    assert.deepEqual(yield* decodeCreated(created), created);
  }),
);

it("preserves native state IDs and workflow categories with stable open and closed groups", () => {
  const state = {
    category: "open",
    name: "In review",
    id: "native-17",
    workflowCategory: "started",
  };
  expect(decodeState(state)).toEqual(state);
  expect(decodeState({ category: "closed", name: "Done" })).toEqual({
    category: "closed",
    name: "Done",
  });
  expect(() => decodeState({ ...state, workflowCategory: "review" })).toThrow();
});

it("bounds issue continuation requests to 200 rows and preserves hierarchy continuation", () => {
  expect(decodePage({ cursor: "native-next", limit: 200 })).toEqual({
    cursor: "native-next",
    limit: 200,
  });
  for (const limit of [0, 201, 1.5]) expect(() => decodePage({ limit })).toThrow();
  expect(() => decodePage({ cursor: "x".repeat(4097) })).toThrow();
  const page = { parent: null, children: { items: [], nextCursor: "next", truncated: true } };
  expect(decodeHierarchy(page)).toEqual(page);
});

it("keeps structured template fields and contact links beside body templates", () => {
  const template = {
    key: "bug.yml",
    name: "Bug",
    about: "Report a bug",
    title: "",
    body: "",
    labels: [],
    assignees: [],
    fields: [
      { kind: "markdown", value: "Steps" },
      {
        kind: "input",
        id: "version",
        label: "Version",
        description: null,
        required: true,
        placeholder: null,
        value: null,
      },
      {
        kind: "dropdown",
        id: "os",
        label: "OS",
        description: null,
        required: true,
        multiple: false,
        options: ["Linux"],
        defaultValues: ["Linux"],
      },
    ],
  };
  expect(decodeTemplate(template)).toEqual(template);
  const list = {
    templates: [template],
    externalTemplates: [],
    blankIssuesEnabled: false,
    contactLinks: [{ name: "Help", about: "Get help", url: "https://example.com/help" }],
    contributingGuidelinesUrl: "https://example.com/contributing",
  };
  expect(decodeTemplates(list)).toEqual(list);
});

it("carries optional template selection through the existing RPC while retaining inline bodies", () => {
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
  ]) {
    const request = { ...input, ...flags };
    expect(decodeTemplateInput(request)).toEqual(request);
    expect(decodeTemplateRpc(request)).toEqual(request);
    expect(decodeScope(request)).toEqual(input);
  }
  const template = {
    key: "Bug",
    name: "Bug",
    about: "",
    title: "",
    body: "",
    labels: [],
    assignees: [],
  };
  expect(decodeTemplate(template)).toEqual(template);
  expect(decodeTemplate({ ...template, contentDeferred: true })).toEqual({
    ...template,
    contentDeferred: true,
  });
  expect(() => decodeTemplate({ ...template, body: undefined, contentDeferred: true })).toThrow();
  expect(() => decodeTemplateInput({ ...input, templateKey: "" })).toThrow();
});

it("preserves distinct native label IDs when labels have the same name", () => {
  const page = {
    items: [
      { id: "team-label-id", name: "Bug", color: null },
      { id: "workspace-label-id", name: "Bug", color: null, description: "Workspace label" },
      { name: "Help", color: "123456" },
    ],
    nextCursor: null,
  };
  expect(decodeLabelPage(page)).toEqual(page);
});

it("keeps URL resolution direct and protected by the read grant", () => {
  const input = { url: "https://github.com/acme/web/issues/1", projectId: ProjectId.make("web") };
  assert.deepEqual(decodeResolveInput(input), input);
  const result = {
    projectId: ProjectId.make("web"),
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "acme/web",
    key: "1",
    writable: true,
  };
  assert.deepEqual(decodeResolved(result), result);
  assert.deepEqual(clientRpcRequiredScopes(WS_METHODS.issuesResolveUrl, input), [
    AuthOrchestrationReadScope,
  ]);
});

it("preserves optional comment-page viewer context while accepting older clients", () => {
  const input = {
    projectId: "project",
    tracker: "linear",
    host: "linear.app",
    scope: "acme/ENG",
    key: "ENG-7",
    cursor: "older",
  };
  expect(decodeComments(input)).toEqual(input);
  expect(decodeComments({ ...input, viewer: "native-viewer" })).toEqual({
    ...input,
    viewer: "native-viewer",
  });
});

it("accepts saved issue links without generation IDs and preserves new IDs", () => {
  const link = {
    projectId: "project",
    tracker: "github",
    host: "github.com",
    scope: "acme/web",
    key: "7",
    url: "https://github.com/acme/web/issues/7",
    source: "agent",
    linkedAt: "2026-10-14T00:00:00.000Z",
    snapshot: null,
  };
  expect(decodeThreadLink(link)).toEqual(link);
  expect(decodeThreadLink({ ...link, linkId: "link-command" })).toEqual({
    ...link,
    linkId: "link-command",
  });
});

it.each(["linear", "jira"])("compares %s native issue identifiers without case", (tracker) => {
  const lower = {
    tracker: IssueTrackerKind.make(tracker),
    host: "Example.com",
    scope: "acme/ENG",
    key: "eng-7",
  };
  const upper = { ...lower, host: "example.com", scope: "ACME/eng", key: "ENG-7" };
  expect(threadIssueKeyOf(lower)).toBe(threadIssueKeyOf(upper));
  expect(threadIssueKeysEqual(lower, upper)).toBe(true);
  for (const other of [
    { host: "other.example.com" },
    { scope: "other/ENG" },
    { key: "ENG-8" },
    { tracker: IssueTrackerKind.make("plugin") },
  ]) {
    expect(threadIssueKeysEqual(lower, { ...upper, ...other })).toBe(false);
  }
});

it("keeps plugin key case and numeric tracker keys exact", () => {
  const key = {
    tracker: IssueTrackerKind.make("plugin"),
    host: "example.com",
    scope: "acme/web",
    key: "Ticket-a",
  };
  expect(threadIssueKeysEqual(key, { ...key, key: "TICKET-A" })).toBe(false);
  for (const tracker of ["github", "gitlab", "forgejo", "azure-devops"]) {
    const numeric = { ...key, tracker: IssueTrackerKind.make(tracker), key: "7" };
    expect(threadIssueKeysEqual(numeric, { ...numeric, key: " 7 " })).toBe(true);
    expect(threadIssueKeysEqual(numeric, { ...numeric, key: "07" })).toBe(false);
    expect(threadIssueKeysEqual({ ...numeric, key: "Ab-7" }, { ...numeric, key: "AB-7" })).toBe(
      false,
    );
  }
});

it.each(["Mount", "Nested/Mount"])(
  "keeps Forgejo mount %s exact while ignoring owner and repo case",
  (mount) => {
    const issue = {
      tracker: IssueTrackerKind.make("forgejo"),
      host: "Forgejo.test",
      scope: `${mount}/Acme/Web`,
      key: "42",
    };
    const alias = { ...issue, host: "forgejo.test", scope: `${mount}/acme/web` };
    const otherMount = { ...alias, scope: `${mount.toLowerCase()}/acme/web` };
    expect(threadIssueKeysEqual(issue, alias)).toBe(true);
    expect(threadIssueKeyOf(issue)).not.toBe(threadIssueKeyOf(otherMount));
    expect(threadIssueKeysEqual(issue, otherMount)).toBe(false);
    expect(issueListCursorKey(alias)).not.toBe(issueListCursorKey(otherMount));
  },
);

it.each(["forgejo", "github", "gitlab", "azure-devops", "linear", "jira", "plugin"])(
  "retains %s scope case matching without a Forgejo mount",
  (tracker) => {
    const issue = {
      tracker: IssueTrackerKind.make(tracker),
      host: "example.test",
      scope: "Acme/Web",
      key: "42",
    };
    expect(threadIssueKeysEqual(issue, { ...issue, scope: "acme/web" })).toBe(true);
    if (tracker !== "forgejo") {
      expect(
        threadIssueKeysEqual(
          { ...issue, scope: "Mount/Acme/Web" },
          { ...issue, scope: "mount/acme/web" },
        ),
      ).toBe(true);
    }
  },
);
