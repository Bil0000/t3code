import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import {
  IssueActor,
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
