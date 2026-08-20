export interface GitHistoryGraphCommit {
  hash: string;
  parentHashes: ReadonlyArray<string>;
  refs?: ReadonlyArray<string>;
}

export interface GitHistoryGraphEdge {
  fromLane: number;
  toLane: number;
  colorIndex: number;
  kind: "continuation" | "incoming" | "parent" | "elided";
  parentHash?: string;
  isMissingParent?: boolean;
}

export const MAX_GIT_HISTORY_GRAPH_LANES = 12;
export const MAX_GIT_HISTORY_GRAPH_EDGES_PER_ROW = MAX_GIT_HISTORY_GRAPH_LANES * 2;

const MAX_TRACKED_LANES = MAX_GIT_HISTORY_GRAPH_LANES - 1;
const ELISION_LANE = MAX_GIT_HISTORY_GRAPH_LANES - 1;

export interface GitHistoryGraphRow {
  hash: string;
  lane: number;
  colorIndex: number;
  hasIncoming: boolean;
  edges: ReadonlyArray<GitHistoryGraphEdge>;
}

export interface GitHistoryGraphLayout {
  laneCount: number;
  rows: ReadonlyArray<GitHistoryGraphRow>;
}

interface Lane {
  hash: string;
  colorIndex: number;
  started: boolean;
}

type LaneSlot = Lane | null;

interface GitHistoryGraphOptions {
  primaryHash?: string;
  primaryHashes?: ReadonlySet<string>;
  includeMissingParents?: boolean;
}

function findLaneIndices(lanes: ReadonlyArray<LaneSlot>, hash: string): number[] {
  return lanes.flatMap((lane, index) => (lane?.hash === hash ? [index] : []));
}

function uniqueHashes(hashes: ReadonlyArray<string>): string[] {
  return Array.from(new Set(hashes));
}

function nextColorIndex(lanes: ReadonlyArray<LaneSlot>): number {
  const usedColors = new Set(lanes.flatMap((lane) => (lane === null ? [] : [lane.colorIndex])));
  let colorIndex = 1;

  while (colorIndex < Number.MAX_SAFE_INTEGER && usedColors.has(colorIndex)) {
    colorIndex += 1;
  }

  return colorIndex;
}

function continuationEdges(
  beforeLanes: ReadonlyArray<LaneSlot>,
  endingLanes: ReadonlySet<number>,
): GitHistoryGraphEdge[] {
  return beforeLanes.flatMap((lane, fromLane) => {
    if (endingLanes.has(fromLane) || lane === null || !lane.started) {
      return [];
    }

    return [
      {
        fromLane,
        toLane: fromLane,
        colorIndex: lane.colorIndex,
        kind: "continuation" as const,
      },
    ];
  });
}

function elidedEdge(fromLane: number, colorIndex: number): GitHistoryGraphEdge {
  return {
    fromLane,
    toLane: ELISION_LANE,
    colorIndex,
    kind: "elided",
  };
}

export function layoutGitHistoryGraph(
  commits: ReadonlyArray<GitHistoryGraphCommit>,
  options: GitHistoryGraphOptions = {},
): GitHistoryGraphLayout {
  const knownHashes = new Set(commits.map((commit) => commit.hash));
  const includeMissingParents = options.includeMissingParents ?? true;
  const currentHeadHash =
    options.primaryHash ??
    commits.find((commit) =>
      commit.refs?.some((ref) => ref === "HEAD" || ref.startsWith("HEAD -> ")),
    )?.hash ??
    commits[0]?.hash;
  const commitsByHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const primaryHashes = new Set(options.primaryHashes);
  if (primaryHashes.size === 0) {
    let primaryHash = currentHeadHash;
    while (primaryHash && !primaryHashes.has(primaryHash)) {
      primaryHashes.add(primaryHash);
      primaryHash = commitsByHash.get(primaryHash)?.parentHashes[0];
    }
  }
  const rows: GitHistoryGraphRow[] = [];
  let lanes: LaneSlot[] = [];
  let laneCount = 0;

  for (const commit of commits) {
    const isPrimary = primaryHashes.has(commit.hash);
    const matchingLanes = findLaneIndices(lanes, commit.hash);
    const activeMatchingLanes = matchingLanes.filter((lane) => lanes[lane]?.started === true);
    const preferredNodeLane = isPrimary ? 0 : (activeMatchingLanes[0] ?? matchingLanes[0] ?? -1);
    const emptyLane = lanes.findIndex(
      (lane, index) => lane === null && index > 0 && index < MAX_TRACKED_LANES,
    );
    const nodeLane =
      preferredNodeLane !== -1
        ? preferredNodeLane
        : emptyLane !== -1
          ? emptyLane
          : Math.max(1, lanes.length) < MAX_TRACKED_LANES
            ? Math.max(1, lanes.length)
            : ELISION_LANE;
    const isElidedNode = nodeLane === ELISION_LANE && matchingLanes.length === 0;
    const existingNodeLane = lanes[nodeLane];
    const nodeColorIndex = isPrimary
      ? (existingNodeLane?.colorIndex ?? 0)
      : (existingNodeLane?.colorIndex ?? nextColorIndex(lanes));
    const beforeLanes = [...lanes];
    if (!isElidedNode) {
      while (beforeLanes.length <= nodeLane) beforeLanes.push(null);
    }
    if (!isElidedNode && (beforeLanes[nodeLane] === null || beforeLanes[nodeLane] === undefined)) {
      beforeLanes[nodeLane] = {
        hash: commit.hash,
        colorIndex: nodeColorIndex,
        started: false,
      };
    }

    const endingLanes = new Set(isElidedNode ? matchingLanes : [...matchingLanes, nodeLane]);
    const incomingEdges: GitHistoryGraphEdge[] = activeMatchingLanes
      .filter((lane) => lane !== nodeLane)
      .map((lane) => ({
        fromLane: lane,
        toLane: nodeLane,
        colorIndex: beforeLanes[lane]?.colorIndex ?? nodeColorIndex,
        kind: "incoming",
      }));
    const afterLanes = [...beforeLanes];
    for (const lane of endingLanes) afterLanes[lane] = null;

    const parentEdges: GitHistoryGraphEdge[] = [];
    const parentHashes = uniqueHashes(commit.parentHashes).filter(
      (parentHash) => includeMissingParents || knownHashes.has(parentHash),
    );
    for (const [parentIndex, parentHash] of parentHashes.entries()) {
      if (isElidedNode || parentEdges.length >= MAX_TRACKED_LANES) {
        break;
      }
      const parentIsPrimary = primaryHashes.has(parentHash);
      const preferredParentLane = parentIsPrimary ? 0 : parentIndex === 0 ? nodeLane : -1;
      const availableParentLane =
        preferredParentLane !== -1 && afterLanes[preferredParentLane] === null
          ? preferredParentLane
          : afterLanes.findIndex(
              (lane, index) => lane === null && index > 0 && index < MAX_TRACKED_LANES,
            );
      const parentLane =
        availableParentLane === -1 && Math.max(1, afterLanes.length) < MAX_TRACKED_LANES
          ? Math.max(1, afterLanes.length)
          : availableParentLane;
      if (parentLane === -1) {
        break;
      }
      const colorIndex = parentIndex === 0 ? nodeColorIndex : nextColorIndex(afterLanes);
      while (afterLanes.length <= parentLane) afterLanes.push(null);
      afterLanes[parentLane] = {
        hash: parentHash,
        colorIndex,
        started: true,
      };
      parentEdges.push({
        fromLane: nodeLane,
        toLane: parentLane,
        colorIndex,
        kind: "parent",
        parentHash,
        isMissingParent: !knownHashes.has(parentHash),
      });
    }

    const hasElidedParents = parentEdges.length < parentHashes.length;
    const edges = [
      ...incomingEdges,
      ...parentEdges,
      ...continuationEdges(beforeLanes, endingLanes),
      ...(hasElidedParents ? [elidedEdge(nodeLane, nodeColorIndex)] : []),
    ];
    rows.push({
      hash: commit.hash,
      lane: nodeLane,
      colorIndex: nodeColorIndex,
      hasIncoming: activeMatchingLanes.includes(nodeLane),
      edges: edges.slice(0, MAX_GIT_HISTORY_GRAPH_EDGES_PER_ROW),
    });

    laneCount = Math.max(
      laneCount,
      isElidedNode ? MAX_GIT_HISTORY_GRAPH_LANES : beforeLanes.length,
      afterLanes.length,
    );
    lanes = afterLanes;
  }

  return { laneCount, rows };
}
