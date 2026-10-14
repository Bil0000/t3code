import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import {
  IssueActor,
  IssueLabelCandidatesPage,
  IssueState,
  IssuePageInput,
  IssueHierarchyPage,
  IssueTemplate,
  IssueTemplateList,
  IssueCapabilities,
  IssueCreateInput,
  IssueCreateResult,
  IssueLinkedPullRequest,
  IssueSummary,
  IssueTrackerKind,
  IssueTrackerProjectBinding,
  StandaloneIssueTrackerDescriptor,
} from "./issue.ts";

const decodeDescriptor = Schema.decodeEffect(StandaloneIssueTrackerDescriptor);
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
