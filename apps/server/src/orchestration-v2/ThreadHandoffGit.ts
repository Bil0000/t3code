import type { VcsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
  readonly timeoutMs?: number;
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
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
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
  /**
   * Writes a bundle carrying `refs`, excluding anything the receiver already
   * has. With no exclusions this is full history, which is what lets a
   * repository the target has never seen arrive without a remote, credentials,
   * or network.
   */
  readonly createBundle: (input: {
    readonly cwd: string;
    readonly outputPath: string;
    readonly refs: ReadonlyArray<string>;
    readonly excludeTips: ReadonlyArray<string>;
  }) => Effect.Effect<boolean, VcsError>;
  /** Imports a bundle's objects and parks its refs under `refs/handoff-incoming/`. */
  readonly importBundle: (input: {
    readonly cwd: string;
    readonly bundlePath: string;
  }) => Effect.Effect<void, VcsError>;
  readonly cloneFromBundle: (input: {
    readonly bundlePath: string;
    readonly targetPath: string;
    readonly branch: string | null;
  }) => Effect.Effect<void, VcsError>;
  /**
   * Applies a tracked-changes patch. `check` runs the same apply as a dry run,
   * which is what lets a hop refuse before touching the working tree.
   */
  readonly applyPatch: (input: {
    readonly cwd: string;
    readonly patch: string;
    readonly check: boolean;
  }) => Effect.Effect<boolean, VcsError>;
  readonly checkoutBranchAt: (input: {
    readonly cwd: string;
    readonly branch: string;
    readonly commit: string;
  }) => Effect.Effect<void, VcsError>;
  readonly resetHardTo: (input: {
    readonly cwd: string;
    readonly commit: string;
  }) => Effect.Effect<void, VcsError>;
  readonly listCheckpointRefs: (input: {
    readonly cwd: string;
  }) => Effect.Effect<ReadonlyArray<string>, VcsError>;
  readonly archivePaths: (input: {
    readonly cwd: string;
    readonly paths: ReadonlyArray<string>;
    readonly outputPath: string;
  }) => Effect.Effect<void, VcsError>;
  readonly extractArchive: (input: {
    readonly cwd: string;
    readonly archivePath: string;
  }) => Effect.Effect<void, VcsError>;
  /** Path of the worktree that has `branch` checked out, if any. */
  readonly findWorktreeForBranch: (input: {
    readonly cwd: string;
    readonly branch: string;
  }) => Effect.Effect<string | null, VcsError>;
  /** Adds a detached worktree at `commit`; attaching a branch is a separate, fallible step. */
  readonly addWorktree: (input: {
    readonly cwd: string;
    readonly path: string;
    readonly commit: string;
  }) => Effect.Effect<void, VcsError>;
  /** True when `branch` is checked out by the repository or any worktree. */
  readonly isBranchCheckedOut: (input: {
    readonly cwd: string;
    readonly branch: string;
  }) => Effect.Effect<boolean, VcsError>;
  /** Restores a stash this hop created, used when an apply is rolled back. */
  readonly popStash: (input: {
    readonly cwd: string;
    readonly stashRef: string;
  }) => Effect.Effect<void, VcsError>;
}

export class ThreadHandoffGit extends Context.Service<ThreadHandoffGit, ThreadHandoffGitShape>()(
  "t3/orchestration-v2/ThreadHandoffGit",
) {}

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

  const createBundle: ThreadHandoffGitShape["createBundle"] = (input) =>
    Effect.gen(function* () {
      const revListArgs = [
        ...input.refs,
        ...(input.excludeTips.length === 0 ? [] : ["--not", ...input.excludeTips]),
      ];
      // A branch whose every commit is already on the excluded tips — fully
      // pushed, the common case — would make `git bundle` refuse with "empty
      // bundle". That is a normal state, not a failure, so it is detected
      // first and reported as "nothing to bundle".
      const count = yield* git({
        operation: "count-bundle-commits",
        args: ["rev-list", "--count", ...revListArgs],
        cwd: input.cwd,
        timeoutMs: 600_000,
      });
      if (count.stdout.trim() === "0") return false;
      yield* git({
        operation: "create-bundle",
        args: ["bundle", "create", input.outputPath, ...revListArgs],
        cwd: input.cwd,
        // Bundling can walk a lot of history; the default probe timeout is
        // far too short for a real repository.
        timeoutMs: 600_000,
      });
      return true;
    });

  const importBundle: ThreadHandoffGitShape["importBundle"] = (input) =>
    git({
      operation: "import-bundle",
      // Fetching from the bundle imports objects and names its refs without
      // moving any local branch, so classification happens before anything the
      // user can see changes.
      args: ["fetch", "--no-tags", input.bundlePath, "+refs/*:refs/handoff-incoming/*"],
      cwd: input.cwd,
    }).pipe(Effect.asVoid);

  const cloneFromBundle: ThreadHandoffGitShape["cloneFromBundle"] = (input) =>
    git({
      operation: "clone-from-bundle",
      args: [
        "clone",
        ...(input.branch === null ? [] : ["--branch", input.branch]),
        input.bundlePath,
        input.targetPath,
      ],
      cwd: ".",
    }).pipe(Effect.asVoid);

  const applyPatch: ThreadHandoffGitShape["applyPatch"] = (input) =>
    git({
      operation: input.check ? "apply-patch-check" : "apply-patch",
      args: ["apply", "--3way", "--binary", ...(input.check ? ["--check"] : []), "-"],
      cwd: input.cwd,
      stdin: input.patch,
      allowNonZeroExit: true,
    }).pipe(Effect.map((output) => output.exitCode === 0));

  const checkoutBranchAt: ThreadHandoffGitShape["checkoutBranchAt"] = (input) =>
    git({
      operation: "checkout-branch-at",
      args: ["checkout", "-B", input.branch, input.commit],
      cwd: input.cwd,
    }).pipe(Effect.asVoid);

  const resetHardTo: ThreadHandoffGitShape["resetHardTo"] = (input) =>
    git({
      operation: "reset-hard-to",
      args: ["reset", "--hard", input.commit],
      cwd: input.cwd,
    }).pipe(Effect.asVoid);

  const listCheckpointRefs: ThreadHandoffGitShape["listCheckpointRefs"] = (input) =>
    git({
      operation: "list-checkpoint-refs",
      args: ["for-each-ref", "--format=%(refname)", "refs/t3code"],
      cwd: input.cwd,
      allowNonZeroExit: true,
      maxOutputBytes: Number.MAX_SAFE_INTEGER,
    }).pipe(
      Effect.map((output) =>
        output.exitCode === 0
          ? output.stdout
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
          : [],
      ),
    );

  const archivePaths: ThreadHandoffGitShape["archivePaths"] = (input) =>
    // A null-delimited file list keeps paths containing spaces or newlines
    // intact, which is the form `git ls-files -z` already produces.
    process
      .run({
        operation: "thread-handoff.archive-paths",
        command: "tar",
        args: ["--null", "--files-from", "-", "-czf", input.outputPath],
        cwd: input.cwd,
        stdin: input.paths.length === 0 ? "" : `${input.paths.join("\0")}\0`,
      })
      .pipe(Effect.asVoid);

  const extractArchive: ThreadHandoffGitShape["extractArchive"] = (input) =>
    process
      .run({
        operation: "thread-handoff.extract-archive",
        command: "tar",
        args: ["-xzf", input.archivePath],
        cwd: input.cwd,
      })
      .pipe(Effect.asVoid);

  const worktreeEntries = (input: { readonly cwd: string }) =>
    git({
      operation: "list-worktrees",
      args: ["worktree", "list", "--porcelain"],
      cwd: input.cwd,
      maxOutputBytes: Number.MAX_SAFE_INTEGER,
    }).pipe(
      Effect.map((output) => {
        const entries: Array<{ path: string; branch: string | null }> = [];
        let current: { path: string; branch: string | null } | null = null;
        for (const line of output.stdout.split("\n")) {
          if (line.startsWith("worktree ")) {
            if (current !== null) entries.push(current);
            current = { path: line.slice("worktree ".length).trim(), branch: null };
          } else if (line.startsWith("branch ") && current !== null) {
            current.branch = line
              .slice("branch ".length)
              .trim()
              .replace(/^refs\/heads\//, "");
          }
        }
        if (current !== null) entries.push(current);
        return entries;
      }),
    );

  const findWorktreeForBranch: ThreadHandoffGitShape["findWorktreeForBranch"] = (input) =>
    worktreeEntries(input).pipe(
      Effect.map((entries) => entries.find((entry) => entry.branch === input.branch)?.path ?? null),
    );

  const isBranchCheckedOut: ThreadHandoffGitShape["isBranchCheckedOut"] = (input) =>
    worktreeEntries(input).pipe(
      Effect.map((entries) => entries.some((entry) => entry.branch === input.branch)),
    );

  const addWorktree: ThreadHandoffGitShape["addWorktree"] = (input) =>
    git({
      operation: "add-worktree",
      args: ["worktree", "add", "--detach", input.path, input.commit],
      cwd: input.cwd,
      timeoutMs: 600_000,
    }).pipe(Effect.asVoid);

  const popStash: ThreadHandoffGitShape["popStash"] = (input) =>
    git({
      operation: "pop-stash",
      args: ["stash", "pop", input.stashRef],
      cwd: input.cwd,
      allowNonZeroExit: true,
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
    createBundle,
    importBundle,
    cloneFromBundle,
    applyPatch,
    checkoutBranchAt,
    resetHardTo,
    listCheckpointRefs,
    archivePaths,
    extractArchive,
    popStash,
    findWorktreeForBranch,
    addWorktree,
    isBranchCheckedOut,
  } satisfies ThreadHandoffGitShape;
});

export const layer: Layer.Layer<ThreadHandoffGit, never, VcsProcess> = Layer.effect(
  ThreadHandoffGit,
  make,
);
