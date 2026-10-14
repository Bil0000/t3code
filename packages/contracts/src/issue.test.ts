import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  IssueActor,
  IssueCandidates,
  IssueUpdateInput,
  ProjectId,
  IssueTrackerKind,
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
