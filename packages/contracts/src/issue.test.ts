import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import {
  IssueActor,
  IssueCreateInput,
  IssueCreateResult,
  IssueTrackerKind,
  IssueTrackerProjectBinding,
  StandaloneIssueTrackerDescriptor,
} from "./issue.ts";

const decodeDescriptor = Schema.decodeEffect(StandaloneIssueTrackerDescriptor);
const decodeActor = Schema.decodeEffect(IssueActor);
const decodeCreate = Schema.decodeEffect(IssueCreateInput);
const decodeCreated = Schema.decodeEffect(IssueCreateResult);
const decodeBinding = Schema.decodeEffect(IssueTrackerProjectBinding);

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
