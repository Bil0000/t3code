import type { PullRequestReaction, PullRequestReactionContent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyPendingPullRequestReactions,
  PULL_REQUEST_REACTION_ORDER,
  pullRequestReactionEmoji,
  pullRequestReactionName,
  pullRequestReactionTooltip,
} from "./pullRequestReactions.logic";

function reaction(overrides: Partial<PullRequestReaction> = {}): PullRequestReaction {
  return {
    content: "heart",
    count: 1,
    actors: ["octocat"],
    viewerHasReacted: false,
    ...overrides,
  };
}

describe("reaction presentation", () => {
  it("names and draws all eight, in GitHub's picker order", () => {
    expect(PULL_REQUEST_REACTION_ORDER).toEqual([
      "thumbs-up",
      "thumbs-down",
      "laugh",
      "hooray",
      "confused",
      "heart",
      "rocket",
      "eyes",
    ]);
    expect(PULL_REQUEST_REACTION_ORDER.map(pullRequestReactionEmoji)).toEqual([
      "👍",
      "👎",
      "😄",
      "🎉",
      "😕",
      "❤️",
      "🚀",
      "👀",
    ]);
    expect(pullRequestReactionName("thumbs-up")).toBe("thumbs up");
    expect(pullRequestReactionName("eyes")).toBe("eyes");
  });
});

describe("reaction tooltip", () => {
  it("reads as GitHub's sentence for one, two and three names", () => {
    expect(
      pullRequestReactionTooltip(reaction({ content: "thumbs-up", count: 1, actors: ["Bil0000"] })),
    ).toBe("Bil0000 reacted with thumbs up emoji");
    expect(pullRequestReactionTooltip(reaction({ count: 2, actors: ["Bil0000", "octocat"] }))).toBe(
      "Bil0000 and octocat reacted with heart emoji",
    );
    expect(
      pullRequestReactionTooltip(
        reaction({
          content: "eyes",
          count: 3,
          actors: ["Bil0000", "octocat"],
          viewerHasReacted: true,
        }),
      ),
    ).toBe("You, Bil0000, and octocat reacted with eyes emoji");
  });

  it("counts everyone past the third name, including the ones the host never named", () => {
    expect(
      pullRequestReactionTooltip(
        reaction({
          content: "rocket",
          count: 15,
          actors: ["a", "b", "c", "d"],
          viewerHasReacted: true,
        }),
      ),
    ).toBe("You, a, b, and 12 others reacted with rocket emoji");
    // A host that counted more than it named still says who is missing.
    expect(pullRequestReactionTooltip(reaction({ count: 2, actors: ["octocat"] }))).toBe(
      "octocat and 1 other reacted with heart emoji",
    );
    // Nothing named at all leaves the count to speak for itself, and nobody to be "other" than.
    expect(pullRequestReactionTooltip(reaction({ count: 4, actors: [] }))).toBe(
      "4 people reacted with heart emoji",
    );
    expect(pullRequestReactionTooltip(reaction({ count: 1, actors: [] }))).toBe(
      "1 person reacted with heart emoji",
    );
  });

  it("names the viewer as You, ahead of the other people who reacted", () => {
    // The host already leaves the viewer's own login out of `actors`.
    expect(
      pullRequestReactionTooltip(
        reaction({ count: 3, actors: ["Bil0000", "octocat"], viewerHasReacted: true }),
      ),
    ).toBe("You, Bil0000, and octocat reacted with heart emoji");
  });

  it("names nobody as You when the viewer has not reacted", () => {
    expect(
      pullRequestReactionTooltip(
        reaction({ count: 2, actors: ["Bil0000", "octocat"], viewerHasReacted: false }),
      ),
    ).toBe("Bil0000 and octocat reacted with heart emoji");
  });

  it("caps the sentence at count for a host that still leaves the viewer's login in actors", () => {
    // `count` says two, but a non-compliant host left the viewer's own login in `actors` too.
    expect(
      pullRequestReactionTooltip(
        reaction({ count: 2, actors: ["Bil0000", "octocat"], viewerHasReacted: true }),
      ),
    ).toBe("You and Bil0000 reacted with heart emoji");
  });
});

describe("pending reactions", () => {
  const pending = (
    entries: ReadonlyArray<readonly [PullRequestReactionContent, boolean]>,
  ): ReadonlyMap<PullRequestReactionContent, boolean> => new Map(entries);

  it("returns the host's list untouched while nothing is in flight", () => {
    const reactions = [reaction()];
    expect(applyPendingPullRequestReactions(reactions, pending([]))).toBe(reactions);
  });

  it("adds a reaction nobody had yet, in picker order", () => {
    const applied = applyPendingPullRequestReactions(
      [reaction({ content: "rocket", count: 2, actors: ["a", "b"] })],
      pending([["thumbs-up", true]]),
    );
    expect(applied).toEqual([
      { content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true },
      { content: "rocket", count: 2, actors: ["a", "b"], viewerHasReacted: false },
    ]);
  });

  it("joins and leaves an existing reaction, and drops the pill nobody is left on", () => {
    expect(
      applyPendingPullRequestReactions(
        [reaction({ count: 2, actors: ["a", "b"] })],
        pending([["heart", true]]),
      ),
    ).toEqual([{ content: "heart", count: 3, actors: ["a", "b"], viewerHasReacted: true }]);
    expect(
      applyPendingPullRequestReactions(
        [reaction({ count: 2, actors: ["a", "b"], viewerHasReacted: true })],
        pending([["heart", false]]),
      ),
    ).toEqual([{ content: "heart", count: 1, actors: ["a", "b"], viewerHasReacted: false }]);
    expect(
      applyPendingPullRequestReactions(
        [reaction({ count: 1, viewerHasReacted: true })],
        pending([["heart", false]]),
      ),
    ).toEqual([]);
  });

  it("ignores a pending state the host has already caught up with", () => {
    const reactions = [reaction({ count: 3, viewerHasReacted: true })];
    expect(applyPendingPullRequestReactions(reactions, pending([["heart", true]]))).toEqual(
      reactions,
    );
    expect(applyPendingPullRequestReactions([], pending([["heart", false]]))).toEqual([]);
  });
});
