import { assert, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  decodeWorkItemCommentsJson,
  decodeWorkItemJson,
  decodeWorkItemUpdatesJson,
  workItemUpdateEvents,
} from "./azureDevOpsIssueJson.ts";

it("preserves native work item relations without adding whole-item reactions", () => {
  const relations = [
    {
      rel: "ArtifactLink",
      url: "vstfs:///Git/PullRequestId/11111111-1111-1111-1111-111111111111%2F22222222-2222-2222-2222-222222222222%2F8",
    },
  ];
  const result = decodeWorkItemJson(
    JSON.stringify({
      id: 7,
      url: "https://acme.visualstudio.com/DefaultCollection/web/_apis/wit/workItems/7",
      fields: { "System.Title": "Issue", "System.CreatedDate": "2026-07-01T00:00:00Z" },
      relations,
      reactions: [{ type: "like", count: 2 }],
    }),
  );
  assert.isTrue(Result.isSuccess(result));
  if (Result.isSuccess(result)) {
    assert.deepStrictEqual(result.success?.relations, relations);
    assert.isFalse("reactions" in result.success!);
  }
});

it("maps the six native reaction names and numeric values and retains comment paging", () => {
  const types = ["like", "dislike", "heart", "hooray", "smile", "confused"];
  const contents = ["thumbs-up", "thumbs-down", "heart", "hooray", "laugh", "confused"] as const;
  for (const numeric of [true, false]) {
    const result = decodeWorkItemCommentsJson(
      JSON.stringify({
        totalCount: 150,
        continuationToken: "opaque&token=next",
        comments: [
          {
            id: 5,
            text: "Hello",
            createdDate: "2026-07-01T00:00:00Z",
            reactions: [
              ...types.map((type, index) => ({
                type: numeric ? index : type,
                count: index + 1,
                isCurrentUserEngaged: index % 2 === 0,
              })),
              { type: "future-type", count: 1 },
              { type: 20, count: 1 },
              { type: "like", count: 0 },
            ],
          },
        ],
      }),
    );
    assert.isTrue(Result.isSuccess(result));
    if (!Result.isSuccess(result)) continue;
    assert.deepStrictEqual(
      result.success.comments[0]?.reactions,
      contents.map((content, index) => ({
        content,
        count: index + 1,
        actors: [],
        viewerHasReacted: index % 2 === 0,
      })),
    );
    assert.strictEqual(result.success.nextCursor, "opaque&token=next");
    assert.strictEqual(result.success.commentCount, 150);
  }
});

it("keeps comments readable when native reactions are null", () => {
  const result = decodeWorkItemCommentsJson(
    JSON.stringify({
      totalCount: 2,
      comments: [null, []].map((reactions, index) => ({
        id: index + 1,
        text: "Hello",
        createdDate: "2026-07-01T00:00:00Z",
        reactions,
      })),
    }),
  );
  assert.isTrue(Result.isSuccess(result));
  if (!Result.isSuccess(result)) return;
  assert.strictEqual(result.success.comments.length, 2);
  assert.deepStrictEqual(
    result.success.comments.map((comment) => comment.reactions),
    [[], []],
  );
  assert.strictEqual(result.success.commentCount, 2);
});

it("keeps relation-only updates at revision one and skips only the creation update", () => {
  const result = decodeWorkItemUpdatesJson(
    JSON.stringify({
      value: [1, 2].map((id) => ({
        id,
        rev: 1,
        revisedDate: "2026-07-02T00:00:00Z",
        relations: {
          added: [
            {
              rel: "ArtifactLink",
              url: "vstfs:///Git/PullRequestId/11111111-1111-1111-1111-111111111111%2F22222222-2222-2222-2222-222222222222%2F8",
            },
          ],
        },
      })),
    }),
  );
  assert.isTrue(Result.isSuccess(result));
  if (!Result.isSuccess(result)) return;
  assert.deepStrictEqual(result.success.value.flatMap(workItemUpdateEvents), [
    {
      id: "azure-update-2-0",
      kind: "referenced",
      actor: null,
      createdAt: "2026-07-02T00:00:00Z",
      detail: "Pull request #8",
    },
  ]);
});

it("represents native state, title, tags, assignee and PR-link changes with stable event IDs", () => {
  const changedDate = "2026-07-02T00:00:00Z";
  const result = decodeWorkItemUpdatesJson(
    JSON.stringify({
      value: [
        {
          id: 3,
          rev: 3,
          revisedDate: "9999-01-01T00:00:00Z",
          revisedBy: { uniqueName: "ada@example.com", displayName: "Ada" },
          fields: {
            "System.ChangedDate": { oldValue: "2026-07-01T00:00:00Z", newValue: changedDate },
            "System.State": { oldValue: "Active", newValue: "Closed" },
            "System.Title": { oldValue: "Old title", newValue: "New title" },
            "System.Tags": { oldValue: "bug; kept", newValue: "kept; urgent; urgent" },
            "System.AssignedTo": {
              oldValue: { uniqueName: "old@example.com" },
              newValue: { uniqueName: "new@example.com" },
            },
            "System.History": { newValue: "A comment, not a state event" },
          },
          relations: {
            added: [
              {
                rel: "ArtifactLink",
                url: "vstfs:///Git/PullRequestId/11111111-1111-1111-1111-111111111111%2F22222222-2222-2222-2222-222222222222%2F8",
              },
            ],
          },
        },
      ],
    }),
  );
  assert.isTrue(Result.isSuccess(result));
  if (!Result.isSuccess(result)) return;
  const update = result.success.value[0]!;
  const events = workItemUpdateEvents(update);
  assert.deepStrictEqual(
    events.map(({ kind, detail }) => ({ kind, detail })),
    [
      { kind: "closed", detail: "Closed" },
      { kind: "renamed", detail: "New title" },
      { kind: "unlabeled", detail: "bug" },
      { kind: "labeled", detail: "urgent" },
      { kind: "unassigned", detail: "old@example.com" },
      { kind: "assigned", detail: "new@example.com" },
      { kind: "referenced", detail: "Pull request #8" },
    ],
  );
  assert.strictEqual(new Set(events.map((event) => event.id)).size, events.length);
  assert.deepStrictEqual(workItemUpdateEvents(update), events);
  for (const event of events) {
    assert.strictEqual(event.createdAt, changedDate);
    assert.strictEqual(event.actor?.login, "ada@example.com");
  }
});

it("does not fabricate state changes for creation, active-state moves or unchanged identities", () => {
  const result = decodeWorkItemUpdatesJson(
    JSON.stringify({
      value: [
        {
          id: 2,
          rev: 2,
          revisedDate: "2026-07-02T00:00:00Z",
          fields: {
            "System.State": { oldValue: "New", newValue: "Active" },
            "System.Title": { oldValue: "Same", newValue: "Same" },
            "System.AssignedTo": {
              oldValue: "ADA@example.com",
              newValue: { uniqueName: "ada@example.com" },
            },
          },
        },
      ],
    }),
  );
  assert.isTrue(Result.isSuccess(result));
  if (!Result.isSuccess(result)) return;
  const update = result.success.value[0]!;
  assert.deepStrictEqual(workItemUpdateEvents(update), []);
  assert.deepStrictEqual(
    workItemUpdateEvents({
      ...update,
      id: 1,
      rev: 1,
      fields: { "System.State": { newValue: "Closed" } },
    }),
    [],
  );
  assert.deepStrictEqual(
    workItemUpdateEvents({ ...update, revisedDate: "9999-01-01T00:00:00Z" }),
    [],
  );
  assert.deepStrictEqual(
    workItemUpdateEvents({
      ...update,
      fields: {
        "System.State": { oldValue: "Closed", newValue: "Active" },
        "System.AssignedTo": { oldValue: "ada@example.com", newValue: null },
      },
    }).map((event) => event.kind),
    ["reopened", "unassigned"],
  );
});
