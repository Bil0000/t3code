import { assert, it } from "@effect/vitest";

import { linearIssueState, linearReactions } from "./LinearIssueProvider.ts";

it("maps Linear workflow states onto the neutral open/closed states", () => {
  assert.strictEqual(linearIssueState("started"), "open");
  assert.strictEqual(linearIssueState("completed"), "closed");
  assert.strictEqual(linearIssueState("canceled"), "closed");
  assert.strictEqual(linearIssueState("duplicate"), "closed");
});

it("groups supported Linear emoji reactions and marks the viewer", () => {
  assert.deepStrictEqual(
    linearReactions(
      [
        { id: "r1", emoji: "👍", user: { id: "u1", name: "Ada" } },
        { id: "r2", emoji: "👍", user: { id: "u2", name: "Grace" } },
        { id: "r3", emoji: "🎉", user: { id: "u2", name: "Grace" } },
        { id: "r4", emoji: "🧵", user: { id: "u3", name: "Ignored" } },
      ],
      "u1",
    ),
    [
      { content: "thumbs-up", count: 2, actors: ["u1", "u2"], viewerHasReacted: true },
      { content: "hooray", count: 1, actors: ["u2"], viewerHasReacted: false },
    ],
  );
});
