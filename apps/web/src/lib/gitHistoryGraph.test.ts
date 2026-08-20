import { describe, expect, it } from "vite-plus/test";

import {
  MAX_GIT_HISTORY_GRAPH_EDGES_PER_ROW,
  MAX_GIT_HISTORY_GRAPH_LANES,
  layoutGitHistoryGraph,
} from "./gitHistoryGraph";

describe("layoutGitHistoryGraph", () => {
  it("lays out a linear history in one lane", () => {
    const layout = layoutGitHistoryGraph([
      { hash: "c", parentHashes: ["b"] },
      { hash: "b", parentHashes: ["a"] },
      { hash: "a", parentHashes: [] },
    ]);

    expect(layout).toEqual({
      laneCount: 1,
      rows: [
        {
          hash: "c",
          lane: 0,
          colorIndex: 0,
          hasIncoming: false,
          edges: [
            {
              fromLane: 0,
              toLane: 0,
              colorIndex: 0,
              kind: "parent",
              parentHash: "b",
              isMissingParent: false,
            },
          ],
        },
        {
          hash: "b",
          lane: 0,
          colorIndex: 0,
          hasIncoming: true,
          edges: [
            {
              fromLane: 0,
              toLane: 0,
              colorIndex: 0,
              kind: "parent",
              parentHash: "a",
              isMissingParent: false,
            },
          ],
        },
        { hash: "a", lane: 0, colorIndex: 0, hasIncoming: true, edges: [] },
      ],
    });
  });

  it("keeps a lane color stable when a commit has a branch decoration", () => {
    const layout = layoutGitHistoryGraph([
      { hash: "head", parentHashes: ["tip"], refs: ["HEAD -> merge-wt", "origin/merge-wt"] },
      { hash: "tip", parentHashes: ["base"] },
      { hash: "base", parentHashes: ["root"], refs: ["fix/602-pr-integration"] },
      { hash: "root", parentHashes: [] },
    ]);

    expect(layout.rows.map((row) => [row.hash, row.lane, row.colorIndex])).toEqual([
      ["head", 0, 0],
      ["tip", 0, 0],
      ["base", 0, 0],
      ["root", 0, 0],
    ]);
    expect(layout.rows[2]?.edges).toContainEqual(
      expect.objectContaining({ kind: "parent", colorIndex: 0, fromLane: 0, toLane: 0 }),
    );
  });

  it("keeps branch lanes and colors stable through a merge", () => {
    const layout = layoutGitHistoryGraph([
      { hash: "merge", parentHashes: ["main", "side"] },
      { hash: "main", parentHashes: ["base"] },
      { hash: "side", parentHashes: ["base"] },
      { hash: "base", parentHashes: [] },
    ]);

    expect(layout.laneCount).toBe(2);
    expect(layout.rows.map((row) => [row.hash, row.lane, row.colorIndex])).toEqual([
      ["merge", 0, 0],
      ["main", 0, 0],
      ["side", 1, 1],
      ["base", 0, 0],
    ]);
    expect(layout.rows[0]?.edges).toEqual([
      {
        fromLane: 0,
        toLane: 0,
        colorIndex: 0,
        kind: "parent",
        parentHash: "main",
        isMissingParent: false,
      },
      {
        fromLane: 0,
        toLane: 1,
        colorIndex: 1,
        kind: "parent",
        parentHash: "side",
        isMissingParent: false,
      },
    ]);
    expect(layout.rows[1]?.edges).toEqual([
      {
        fromLane: 0,
        toLane: 0,
        colorIndex: 0,
        kind: "parent",
        parentHash: "base",
        isMissingParent: false,
      },
      { fromLane: 1, toLane: 1, colorIndex: 1, kind: "continuation" },
    ]);
    expect(layout.rows[2]?.edges).toEqual([
      {
        fromLane: 1,
        toLane: 1,
        colorIndex: 1,
        kind: "parent",
        parentHash: "base",
        isMissingParent: false,
      },
      { fromLane: 0, toLane: 0, colorIndex: 0, kind: "continuation" },
    ]);
    expect(layout.rows[3]?.edges).toEqual([
      {
        fromLane: 1,
        toLane: 0,
        colorIndex: 1,
        kind: "incoming",
      },
    ]);
  });

  it("allocates one lane for each octopus parent", () => {
    const layout = layoutGitHistoryGraph([
      { hash: "octopus", parentHashes: ["first", "second", "third"] },
      { hash: "first", parentHashes: [] },
      { hash: "second", parentHashes: [] },
      { hash: "third", parentHashes: [] },
    ]);

    expect(layout.laneCount).toBe(3);
    expect(layout.rows[0]?.edges).toEqual([
      {
        fromLane: 0,
        toLane: 0,
        colorIndex: 0,
        kind: "parent",
        parentHash: "first",
        isMissingParent: false,
      },
      {
        fromLane: 0,
        toLane: 1,
        colorIndex: 1,
        kind: "parent",
        parentHash: "second",
        isMissingParent: false,
      },
      {
        fromLane: 0,
        toLane: 2,
        colorIndex: 2,
        kind: "parent",
        parentHash: "third",
        isMissingParent: false,
      },
    ]);
    expect(layout.rows.map((row) => [row.hash, row.lane, row.colorIndex])).toEqual([
      ["octopus", 0, 0],
      ["first", 0, 0],
      ["second", 1, 1],
      ["third", 2, 2],
    ]);
  });

  it("never moves a continuation lane sideways without a commit", () => {
    const layout = layoutGitHistoryGraph([
      { hash: "merge", parentHashes: ["main", "side"] },
      { hash: "main", parentHashes: ["base"] },
      { hash: "side", parentHashes: ["base"] },
      { hash: "base", parentHashes: [] },
    ]);

    const continuations = layout.rows.flatMap((row) =>
      row.edges.filter((edge) => edge.kind === "continuation"),
    );
    expect(continuations.every((edge) => edge.fromLane === edge.toLane)).toBe(true);
  });

  it("keeps the first-parent history in one straight primary lane", () => {
    const layout = layoutGitHistoryGraph([
      { hash: "head", parentHashes: ["merge"] },
      { hash: "merge", parentHashes: ["main", "side"] },
      { hash: "side", parentHashes: ["base"] },
      { hash: "main", parentHashes: ["base"] },
      { hash: "base", parentHashes: [] },
    ]);

    expect(
      layout.rows
        .filter((row) => ["head", "merge", "main", "base"].includes(row.hash))
        .map((row) => row.lane),
    ).toEqual([0, 0, 0, 0]);
  });

  it("reserves the primary lane for the decorated current HEAD ancestry", () => {
    const layout = layoutGitHistoryGraph([
      { hash: "other", parentHashes: [] },
      { hash: "head", parentHashes: ["main"], refs: ["HEAD -> feature/current"] },
      { hash: "main", parentHashes: ["base"] },
      { hash: "base", parentHashes: [] },
    ]);

    expect(layout.rows.map((row) => [row.hash, row.lane])).toEqual([
      ["other", 1],
      ["head", 0],
      ["main", 0],
      ["base", 0],
    ]);
    expect(layout.rows[0]?.edges.some((edge) => edge.fromLane === 0)).toBe(false);
    expect(layout.rows[1]?.hasIncoming).toBe(false);
  });

  it("does not create a branch edge from a continuation lane", () => {
    const layout = layoutGitHistoryGraph([
      { hash: "merge", parentHashes: ["main", "side"] },
      { hash: "main", parentHashes: ["base"] },
      { hash: "side", parentHashes: ["base"] },
      { hash: "base", parentHashes: [] },
    ]);

    expect(
      layout.rows.flatMap((row) =>
        row.edges.filter((edge) => edge.kind === "parent").map((edge) => [row.lane, edge.fromLane]),
      ),
    ).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
      [1, 1],
    ]);
  });

  it("keeps missing page-boundary parents visible and starts unrelated commits in a new lane", () => {
    const layout = layoutGitHistoryGraph([
      { hash: "newest", parentHashes: ["older-than-page"] },
      { hash: "unrelated", parentHashes: [] },
    ]);

    expect(layout).toEqual({
      laneCount: 2,
      rows: [
        {
          hash: "newest",
          lane: 0,
          colorIndex: 0,
          hasIncoming: false,
          edges: [
            {
              fromLane: 0,
              toLane: 0,
              colorIndex: 0,
              kind: "parent",
              parentHash: "older-than-page",
              isMissingParent: true,
            },
          ],
        },
        {
          hash: "unrelated",
          lane: 1,
          colorIndex: 1,
          hasIncoming: false,
          edges: [{ fromLane: 0, toLane: 0, colorIndex: 0, kind: "continuation" }],
        },
      ],
    });
  });

  it("is deterministic and does not duplicate an edge for repeated parent hashes", () => {
    const commits = [
      { hash: "tip", parentHashes: ["base", "base"] },
      { hash: "base", parentHashes: [] },
    ];

    expect(layoutGitHistoryGraph(commits)).toEqual(layoutGitHistoryGraph(commits));
    expect(layoutGitHistoryGraph(commits).rows[0]?.edges).toHaveLength(1);
  });

  it("compacts a 1001-commit high-parent snapshot into bounded, explicit graph elisions", () => {
    const parentHashes = Array.from({ length: 1_000 }, (_, index) => `parent-${index}`);
    const layout = layoutGitHistoryGraph([
      { hash: "merge", parentHashes },
      ...parentHashes.map((hash) => ({ hash, parentHashes: [] })),
    ]);

    expect(layout.rows).toHaveLength(1_001);
    expect(layout.laneCount).toBeLessThanOrEqual(MAX_GIT_HISTORY_GRAPH_LANES);
    expect(layout.rows.every((row) => row.lane < MAX_GIT_HISTORY_GRAPH_LANES)).toBe(true);
    expect(
      layout.rows.every((row) => row.edges.length <= MAX_GIT_HISTORY_GRAPH_EDGES_PER_ROW),
    ).toBe(true);
    expect(layout.rows.flatMap((row) => row.edges).length).toBeLessThanOrEqual(
      layout.rows.length * MAX_GIT_HISTORY_GRAPH_EDGES_PER_ROW,
    );
    expect(
      layout.rows.flatMap((row) => row.edges).filter((edge) => edge.kind === "elided"),
    ).toEqual([expect.objectContaining({ fromLane: 0, toLane: MAX_GIT_HISTORY_GRAPH_LANES - 1 })]);
    expect(
      layout.rows.every((row) =>
        row.edges
          .filter((edge) => edge.kind === "parent" || edge.kind === "elided")
          .every((edge) => edge.fromLane === row.lane),
      ),
    ).toBe(true);
  });
});
