import type { VcsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { VcsProcess } from "../vcs/VcsProcess.ts";

/**
 * How an incoming branch tip relates to the one the receiving repository is
 * already sitting on.
 *
 * The whole safety model of a handoff reduces to this classification, and to
 * the rule it enforces: a branch tip only ever moves to a descendant of
 * itself, on either machine. `advance` is the only outcome that moves a
 * pointer forward, `absorb` keeps the local tip and merges the sender's
 * working state on top of it, and the remaining two write nothing at all.
 */
export type HandoffTipClassification = "advance" | "absorb" | "diverged" | "unrelated";

export interface ClassifyIncomingTipInput {
  /** Null when the receiving repository has no such branch yet. */
  readonly localTip: string | null;
  readonly incomingTip: string;
  /** The incoming commit has the local tip in its ancestry. */
  readonly incomingContainsLocal: boolean;
  /** The local tip has the incoming commit in its ancestry. */
  readonly localContainsIncoming: boolean;
  /** The two commits share any ancestor at all. */
  readonly hasCommonAncestor: boolean;
}

export function classifyIncomingTip(input: ClassifyIncomingTipInput): HandoffTipClassification {
  if (input.localTip === null) return "advance";
  if (input.localTip === input.incomingTip) return "absorb";
  // Containment is checked before common ancestry: a commit that contains the
  // other trivially shares history with it, and answering "unrelated" for a
  // fast-forward would refuse a transfer that is safe by construction.
  if (input.incomingContainsLocal) return "advance";
  if (input.localContainsIncoming) return "absorb";
  return input.hasCommonAncestor ? "diverged" : "unrelated";
}

/**
 * Where the sender's commits are parked when a hop is refused. The receiving
 * side writes them under its own namespace before deciding, so a refusal still
 * leaves the user holding both histories and able to join them by hand.
 */
export function handoffRefName(environmentId: string, branch: string): string {
  return `refs/handoff/${environmentId}/${branch}`;
}

/** Tag written over the old tip before any pointer moves. */
export function handoffPreTagName(handoffId: string): string {
  return `handoff-pre-${handoffId}`;
}

/** Stash label for a dirty receiving worktree; the base sha makes a later pop legible. */
export function handoffStashLabel(handoffId: string, baseSha: string): string {
  return `handoff-overwritten-${handoffId}-base-${baseSha}`;
}

interface GitInput {
  readonly operation: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly stdin?: string;
  readonly allowNonZeroExit?: boolean;
  readonly maxOutputBytes?: number;
}

const runGit = (process: VcsProcess["Service"], input: GitInput) =>
  process.run({
    operation: `thread-handoff.${input.operation}`,
    command: "git",
    args: input.args,
    cwd: input.cwd,
    ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
    ...(input.allowNonZeroExit === undefined ? {} : { allowNonZeroExit: input.allowNonZeroExit }),
    ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
  });

export interface ThreadHandoffGitShape {
  /** Current tip of `branch`, or null when the branch does not exist. */
  readonly resolveTip: (input: {
    readonly cwd: string;
    readonly branch: string;
  }) => Effect.Effect<string | null, VcsError>;
  readonly resolveHead: (input: { readonly cwd: string }) => Effect.Effect<string, VcsError>;
  readonly isAncestor: (input: {
    readonly cwd: string;
    readonly ancestor: string;
    readonly descendant: string;
  }) => Effect.Effect<boolean, VcsError>;
  readonly hasCommonAncestor: (input: {
    readonly cwd: string;
    readonly left: string;
    readonly right: string;
  }) => Effect.Effect<boolean, VcsError>;
  readonly hasCommit: (input: {
    readonly cwd: string;
    readonly commit: string;
  }) => Effect.Effect<boolean, VcsError>;
  /** Tracked changes against HEAD, binary-safe so images and lockfiles survive. */
  readonly trackedPatch: (input: { readonly cwd: string }) => Effect.Effect<string, VcsError>;
  readonly untrackedPaths: (input: {
    readonly cwd: string;
  }) => Effect.Effect<ReadonlyArray<string>, VcsError>;
  readonly dirtyFileCount: (input: { readonly cwd: string }) => Effect.Effect<number, VcsError>;
  /** True when `commit` is reachable from any remote-tracking ref, so rewriting it is off the table. */
  readonly isPublished: (input: {
    readonly cwd: string;
    readonly commit: string;
  }) => Effect.Effect<boolean, VcsError>;
  readonly tagCommit: (input: {
    readonly cwd: string;
    readonly tag: string;
    readonly commit: string;
  }) => Effect.Effect<void, VcsError>;
  readonly stashWorktree: (input: {
    readonly cwd: string;
    readonly label: string;
  }) => Effect.Effect<string | null, VcsError>;
  readonly writeRef: (input: {
    readonly cwd: string;
    readonly ref: string;
    readonly commit: string;
  }) => Effect.Effect<void, VcsError>;
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess;
  const git = (input: GitInput) => runGit(process, input);

  const resolveTip: ThreadHandoffGitShape["resolveTip"] = (input) =>
    git({
      operation: "resolve-tip",
      args: ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}`],
      cwd: input.cwd,
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((output) => {
        const tip = output.stdout.trim();
        return output.exitCode === 0 && tip.length > 0 ? tip : null;
      }),
    );

  const resolveHead: ThreadHandoffGitShape["resolveHead"] = (input) =>
    git({ operation: "resolve-head", args: ["rev-parse", "HEAD"], cwd: input.cwd }).pipe(
      Effect.map((output) => output.stdout.trim()),
    );

  const isAncestor: ThreadHandoffGitShape["isAncestor"] = (input) =>
    git({
      operation: "is-ancestor",
      args: ["merge-base", "--is-ancestor", input.ancestor, input.descendant],
      cwd: input.cwd,
      allowNonZeroExit: true,
    }).pipe(Effect.map((output) => output.exitCode === 0));

  const hasCommonAncestor: ThreadHandoffGitShape["hasCommonAncestor"] = (input) =>
    git({
      operation: "has-common-ancestor",
      args: ["merge-base", input.left, input.right],
      cwd: input.cwd,
      allowNonZeroExit: true,
    }).pipe(Effect.map((output) => output.exitCode === 0 && output.stdout.trim().length > 0));

  const hasCommit: ThreadHandoffGitShape["hasCommit"] = (input) =>
    git({
      operation: "has-commit",
      args: ["cat-file", "-e", `${input.commit}^{commit}`],
      cwd: input.cwd,
      allowNonZeroExit: true,
    }).pipe(Effect.map((output) => output.exitCode === 0));

  const trackedPatch: ThreadHandoffGitShape["trackedPatch"] = (input) =>
    git({
      operation: "tracked-patch",
      // --binary keeps images and other non-text changes intact; without it a
      // dirty png silently arrives as "Binary files differ" and never applies.
      args: ["diff", "--binary", "--no-color", "HEAD"],
      cwd: input.cwd,
      maxOutputBytes: Number.MAX_SAFE_INTEGER,
    }).pipe(Effect.map((output) => output.stdout));

  const untrackedPaths: ThreadHandoffGitShape["untrackedPaths"] = (input) =>
    git({
      operation: "untracked-paths",
      args: ["ls-files", "--others", "--exclude-standard", "-z"],
      cwd: input.cwd,
      maxOutputBytes: Number.MAX_SAFE_INTEGER,
    }).pipe(Effect.map((output) => output.stdout.split("\0").filter((path) => path.length > 0)));

  const dirtyFileCount: ThreadHandoffGitShape["dirtyFileCount"] = (input) =>
    git({
      operation: "dirty-file-count",
      args: ["status", "--porcelain", "-z"],
      cwd: input.cwd,
      maxOutputBytes: Number.MAX_SAFE_INTEGER,
    }).pipe(
      Effect.map(
        (output) => output.stdout.split("\0").filter((entry) => entry.trim().length > 0).length,
      ),
    );

  const isPublished: ThreadHandoffGitShape["isPublished"] = (input) =>
    git({
      operation: "is-published",
      args: ["branch", "--remotes", "--contains", input.commit],
      cwd: input.cwd,
      allowNonZeroExit: true,
    }).pipe(Effect.map((output) => output.exitCode === 0 && output.stdout.trim().length > 0));

  const tagCommit: ThreadHandoffGitShape["tagCommit"] = (input) =>
    git({
      operation: "tag-commit",
      args: ["tag", "--force", input.tag, input.commit],
      cwd: input.cwd,
    }).pipe(Effect.asVoid);

  const stashWorktree: ThreadHandoffGitShape["stashWorktree"] = (input) =>
    Effect.gen(function* () {
      const dirty = yield* dirtyFileCount({ cwd: input.cwd });
      if (dirty === 0) return null;
      yield* git({
        operation: "stash-worktree",
        args: ["stash", "push", "--include-untracked", "--message", input.label],
        cwd: input.cwd,
      });
      const stash = yield* git({
        operation: "stash-ref",
        args: ["rev-parse", "--verify", "--quiet", "refs/stash"],
        cwd: input.cwd,
        allowNonZeroExit: true,
      });
      const ref = stash.stdout.trim();
      return ref.length > 0 ? ref : null;
    });

  const writeRef: ThreadHandoffGitShape["writeRef"] = (input) =>
    git({
      operation: "write-ref",
      args: ["update-ref", input.ref, input.commit],
      cwd: input.cwd,
    }).pipe(Effect.asVoid);

  return {
    resolveTip,
    resolveHead,
    isAncestor,
    hasCommonAncestor,
    hasCommit,
    trackedPatch,
    untrackedPaths,
    dirtyFileCount,
    isPublished,
    tagCommit,
    stashWorktree,
    writeRef,
  } satisfies ThreadHandoffGitShape;
});
