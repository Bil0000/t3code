# Stacked Pull Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a simple GitHub stacked pull request workflow across T3 Code's server, web, desktop-hosted web, and mobile Git surfaces.

**Architecture:** Keep normal pull requests unchanged. Add one concrete GitHub stack service around the official `gh stack` CLI and GitHub Stacks REST API, expose it through typed RPCs, and join stack membership into existing PR and Git state in client-runtime.

**Tech Stack:** TypeScript, Effect Schema and services, typed WebSocket RPC, React 19, Tailwind 4, React Native, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-13-stacked-pull-requests-design.md`

## Global Constraints

- GitHub first. GitLab, Bitbucket, and Azure DevOps return unsupported.
- Use official `gh stack`; do not implement rebasing, force-push, or stack metadata storage in T3.
- Keep current single-PR and commit/push workflows unchanged.
- User-facing copy uses `step`; stack-specific Git jargon stays out of primary actions.
- No new runtime dependency, top-level Stacks page, design system, or provider-specific agent prompt.
- All reads and mutations run on the environment server for local, remote, relay, and tunnel clients.
- One remote stack read per project; no per-PR stack request loops.
- Every behavior change follows red-green TDD and gets a focused test.

---

### Task 1: Stack contracts and RPC surface

**Files:**

- Create: `packages/contracts/src/pullRequestStack.ts`
- Create: `packages/contracts/src/pullRequestStack.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/environment.ts`

**Interfaces:**

- Produces: `PullRequestStackSummary`, `PullRequestLocalStack`, `PullRequestStackListInput`, `PullRequestStackCurrentInput`, `PullRequestStackActionInput`, `PullRequestStackMergeInput`, result schemas, and `PullRequestStackError`.

- [ ] **Step 1: Write failing schema round-trip tests**

```ts
it("keeps remote stack steps in bottom-to-top order", () => {
  const decoded = Schema.decodeUnknownSync(PullRequestStackSummary)({
    id: 41,
    number: 7,
    url: "https://github.com/acme/app/stacks/7",
    baseBranch: "main",
    open: true,
    steps: [
      { position: 1, pullRequestNumber: 10, branch: "auth", state: "open", draft: false },
      { position: 2, pullRequestNumber: 11, branch: "api", state: "open", draft: true },
    ],
  });
  expect(decoded.steps.map((step) => step.pullRequestNumber)).toEqual([10, 11]);
});
```

- [ ] **Step 2: Run the new contract test and verify missing exports fail**

Run: `corepack pnpm exec vp test run packages/contracts/src/pullRequestStack.test.ts`

- [ ] **Step 3: Add the minimum schemas and RPC methods**

```ts
export const PullRequestStackAction = Schema.Literals([
  "start",
  "add_step",
  "submit",
  "sync",
  "unstack",
]);

export const PullRequestStackStepState = Schema.Literals(["open", "closed", "merged", "queued"]);
```

Add read RPCs for remote stacks and current local stack. Add mutation RPCs for stack actions and merge. Export the schemas through the contracts package.

- [ ] **Step 4: Run contract tests and typecheck**

Run: `corepack pnpm exec vp test run packages/contracts/src/pullRequestStack.test.ts packages/contracts/src/git.test.ts packages/contracts/src/pullRequest.test.ts`

Run: `corepack pnpm exec vp run --filter @t3tools/contracts typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): define pull request stacks"
```

### Task 2: GitHub stack JSON and command adapter

**Files:**

- Create: `apps/server/src/pullRequestStack/gitHubPullRequestStackJson.ts`
- Create: `apps/server/src/pullRequestStack/gitHubPullRequestStackJson.test.ts`
- Create: `apps/server/src/pullRequestStack/GitHubPullRequestStackService.ts`
- Create: `apps/server/src/pullRequestStack/GitHubPullRequestStackService.test.ts`
- Read before editing: `.repos/effect-smol/LLMS.md`

**Interfaces:**

- Consumes: Task 1 stack contracts, `GitHubCli.execute`, and `VcsProcess.run`.
- Produces: one concrete `GitHubPullRequestStackService` with `list`, `current`, `runAction`, and `merge` methods.

- [ ] **Step 1: Write failing decoder tests from official JSON**

```ts
it("decodes a local gh stack view", () => {
  expect(
    decodeLocalStackJson(
      JSON.stringify({
        trunk: "main",
        currentBranch: "api",
        branches: [
          {
            name: "auth",
            head: "a1",
            base: "main",
            isCurrent: false,
            isMerged: false,
            isQueued: false,
            needsRebase: false,
            pr: { number: 10, url: "https://github.com/acme/app/pull/10", state: "OPEN" },
          },
          {
            name: "api",
            head: "b2",
            base: "auth",
            isCurrent: true,
            isMerged: false,
            isQueued: false,
            needsRebase: true,
            pr: { number: 11, url: "https://github.com/acme/app/pull/11", state: "OPEN" },
          },
        ],
      }),
    )._tag,
  ).toBe("Success");
});
```

Also cover malformed JSON, remote stack order, drafts, merged dates, empty lists, and output truncation.

- [ ] **Step 2: Run decoder tests and verify failure**

Run: `corepack pnpm exec vp test run apps/server/src/pullRequestStack/gitHubPullRequestStackJson.test.ts`

- [ ] **Step 3: Implement literal Effect schemas and normalization**

Remote input fields are `id`, `number`, `url`, `base.ref`, `open`, and `pull_requests`. Local input fields match `gh stack view --json`: `trunk`, `currentBranch`, and `branches`.

- [ ] **Step 4: Write failing service tests around the process boundary**

Tests must prove:

- Exit code `2` from `gh stack view --json` returns `stack: null`.
- Other non-zero exit codes fail with `PullRequestStackError`.
- `list` calls `gh api repos/{owner}/{repo}/stacks` once.
- `start`, `add_step`, `submit`, `sync`, and `unstack` use exact non-interactive arguments.
- `merge` uses the PR number and `--yes`.
- Every successful mutation reads fresh state before returning.

- [ ] **Step 5: Implement the concrete service**

```ts
export class GitHubPullRequestStackService extends Context.Service<
  GitHubPullRequestStackService,
  {
    readonly list: (
      input: PullRequestStackListInput,
    ) => Effect.Effect<PullRequestStackListResult, PullRequestStackError>;
    readonly current: (
      input: PullRequestStackCurrentInput,
    ) => Effect.Effect<PullRequestStackCurrentResult, PullRequestStackError>;
    readonly runAction: (
      input: PullRequestStackActionInput,
    ) => Effect.Effect<PullRequestStackActionResult, PullRequestStackError>;
    readonly merge: (
      input: PullRequestStackMergeInput,
    ) => Effect.Effect<PullRequestStackMergeResult, PullRequestStackError>;
  }
>()("t3/pullRequestStack/GitHubPullRequestStackService") {}
```

Use `VcsProcess.run({ allowNonZeroExit: true })` only for typed `gh stack view` exit handling. Use the existing GitHub CLI wrapper for normal API calls.

- [ ] **Step 6: Run focused server tests and typecheck**

Run: `corepack pnpm exec vp test run apps/server/src/pullRequestStack/gitHubPullRequestStackJson.test.ts apps/server/src/pullRequestStack/GitHubPullRequestStackService.test.ts apps/server/src/sourceControl/GitHubCli.test.ts`

Run: `corepack pnpm exec vp run --filter t3 typecheck`

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/pullRequestStack
git commit -m "feat(server): add GitHub stack service"
```

### Task 3: Server wiring, authorization, and discovery

**Files:**

- Modify: `apps/server/src/ws.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/auth/RpcAuthorization.ts`
- Modify: `apps/server/src/environment/ServerEnvironment.ts`
- Modify: `apps/server/src/sourceControl/SourceControlDiscovery.ts`
- Modify: `apps/server/src/sourceControl/SourceControlDiscovery.test.ts`

**Interfaces:**

- Consumes: Task 2 service.
- Produces: callable typed RPCs and GitHub stack availability in environment discovery.

- [ ] **Step 1: Write failing discovery and authorization tests**

Add cases for installed extension, missing extension, GitHub stacks unavailable, read RPC access, and mutation operate access.

- [ ] **Step 2: Run tests and verify failure**

Run: `corepack pnpm exec vp test run apps/server/src/sourceControl/SourceControlDiscovery.test.ts apps/server/src/auth/RpcAuthorization.test.ts`

- [ ] **Step 3: Wire service and RPC handlers**

Reads call `list` and `current`. Mutations call `runAction` and `merge`. The server advertises stack support only when GitHub CLI and the stack extension are available.

- [ ] **Step 4: Run focused tests and server typecheck**

Run: `corepack pnpm exec vp test run apps/server/src/sourceControl/SourceControlDiscovery.test.ts apps/server/src/pullRequestStack/GitHubPullRequestStackService.test.ts`

Run: `corepack pnpm exec vp run --filter t3 typecheck`

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/ws.ts apps/server/src/server.ts apps/server/src/auth apps/server/src/environment apps/server/src/sourceControl
git commit -m "feat(server): expose stack operations"
```

### Task 4: Shared stack state and pure presentation logic

**Files:**

- Create: `packages/client-runtime/src/state/pullRequestStacks.ts`
- Create: `packages/client-runtime/src/state/pullRequestStacks.test.ts`
- Modify: `packages/client-runtime/src/index.ts`
- Create: `apps/web/src/components/pullRequest/pullRequestStack.logic.ts`
- Create: `apps/web/src/components/pullRequest/pullRequestStack.logic.test.ts`

**Interfaces:**

- Consumes: Task 1 RPCs.
- Produces: cached remote/local stack atoms, serialized actions, `stackForPullRequest`, `stepStatus`, and `nextReviewStep`.

- [ ] **Step 1: Write failing pure behavior tests**

```ts
it("finds a pull request without changing server order", () => {
  const match = stackForPullRequest(stacks, 11);
  expect(match?.position).toBe(2);
  expect(match?.total).toBe(3);
});
```

Cover no stack, first/middle/last positions, merged and queued steps, stale later steps, blockers, and next review navigation.

- [ ] **Step 2: Run tests and verify failure**

Run: `corepack pnpm exec vp test run packages/client-runtime/src/state/pullRequestStacks.test.ts apps/web/src/components/pullRequest/pullRequestStack.logic.test.ts`

- [ ] **Step 3: Implement atoms and small pure functions**

Keep network state in client-runtime. Keep labels and display derivation in web logic. Serialize mutations by project or working directory using the same manager pattern as Git actions.

- [ ] **Step 4: Run tests and typechecks**

Run: `corepack pnpm exec vp test run packages/client-runtime/src/state/pullRequestStacks.test.ts apps/web/src/components/pullRequest/pullRequestStack.logic.test.ts`

Run: `corepack pnpm exec vp run --filter @t3tools/client-runtime typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/client-runtime apps/web/src/components/pullRequest/pullRequestStack.logic.*
git commit -m "feat(client): add pull request stack state"
```

### Task 5: Pull Requests page and right-panel stack experience

**Files:**

- Create: `apps/web/src/components/pullRequest/PullRequestStackBar.tsx`
- Create: `apps/web/src/components/pullRequest/PullRequestStackBar.test.tsx`
- Modify: `apps/web/src/components/pullRequest/PullRequestDetailPanel.tsx`
- Modify: `apps/web/src/components/pullRequest/PullRequestRow.tsx`
- Modify: `apps/web/src/routes/_chat.pull-requests.tsx`
- Modify: `apps/web/src/components/pullRequest/pullRequestList.logic.ts`
- Modify: `apps/web/src/components/pullRequest/pullRequestList.logic.test.ts`

**Interfaces:**

- Consumes: Task 4 stack state and logic.
- Produces: stack badge, connected popover, selected-step navigation, exact merge scope, and review-next-step action.

- [ ] **Step 1: Write failing list and stack-bar tests**

Tests prove:

- A normal PR row is unchanged.
- A stacked PR row shows `Step 2 of 4`.
- Popover order is top-to-bottom with the base branch last.
- Current step is exposed through `aria-current`.
- Selecting a step selects that PR through the existing route state.
- Merge label and confirmation include only steps through the selected PR.

- [ ] **Step 2: Run tests and verify failure**

Run: `corepack pnpm exec vp test run apps/web/src/components/pullRequest/PullRequestStackBar.test.tsx apps/web/src/components/pullRequest/pullRequestList.logic.test.ts`

- [ ] **Step 3: Build one focused stack bar**

Use current Base UI popover, buttons, tokens, and Lucide icons. The connector is static. Keep the normal detail header, tabs, description, reactions, comments, timeline, commits, diff, and review state unchanged.

- [ ] **Step 4: Add list badges and route selection**

Join the single per-project stack response with existing rows. Do not fetch per row and do not add a separate route.

- [ ] **Step 5: Run web tests, lint, and typecheck**

Run: `corepack pnpm exec vp test run apps/web/src/components/pullRequest/PullRequestStackBar.test.tsx apps/web/src/components/pullRequest/pullRequestList.logic.test.ts apps/web/src/components/pullRequest/pullRequestDetail.logic.test.ts`

Run: `corepack pnpm exec vp lint apps/web/src/components/pullRequest/PullRequestStackBar.tsx apps/web/src/components/pullRequest/PullRequestDetailPanel.tsx apps/web/src/components/pullRequest/PullRequestRow.tsx apps/web/src/routes/_chat.pull-requests.tsx`

Run: `corepack pnpm exec vp run --filter @t3tools/web typecheck`

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/pullRequest apps/web/src/routes/_chat.pull-requests.tsx
git commit -m "feat(web): show stacks in pull requests"
```

### Task 6: Git actions, branch toolbar, commands, and settings

**Files:**

- Modify: `apps/web/src/components/GitActionsControl.logic.ts`
- Modify: `apps/web/src/components/GitActionsControl.logic.test.ts`
- Modify: `apps/web/src/components/GitActionsControl.tsx`
- Modify: `apps/web/src/components/BranchToolbar.tsx`
- Modify: `apps/web/src/components/CommandPalette.tsx`
- Modify: `apps/web/src/components/settings/SourceControlSettings.tsx`

**Interfaces:**

- Consumes: Task 4 current-stack state and actions.
- Produces: Start stack, Start next step, Share stack, Refresh stack, and Unstack controls.

- [ ] **Step 1: Write failing action-availability tests**

Cover normal repository, default branch, current non-stack branch, middle step, top step, dirty worktree, missing extension, running action, and unsupported repository.

- [ ] **Step 2: Run logic tests and verify failure**

Run: `corepack pnpm exec vp test run apps/web/src/components/GitActionsControl.logic.test.ts`

- [ ] **Step 3: Add minimum contextual actions**

Keep Commit, Push, and Create PR unchanged outside a stack. Inside a stack, add only valid stack actions. Reuse existing dialogs, progress UI, toasts, branch metadata updates, and source-control settings patterns.

- [ ] **Step 4: Add branch and command access**

Branch toolbar shows the same stack bar compactly. Command palette mirrors valid actions without default keybindings.

- [ ] **Step 5: Run focused tests, lint, and web typecheck**

Run: `corepack pnpm exec vp test run apps/web/src/components/GitActionsControl.logic.test.ts apps/web/src/components/pullRequest/pullRequestStack.logic.test.ts`

Run: `corepack pnpm exec vp lint apps/web/src/components/GitActionsControl.tsx apps/web/src/components/GitActionsControl.logic.ts apps/web/src/components/BranchToolbar.tsx apps/web/src/components/CommandPalette.tsx apps/web/src/components/settings/SourceControlSettings.tsx`

Run: `corepack pnpm exec vp run --filter @t3tools/web typecheck`

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components
git commit -m "feat(web): add stack Git actions"
```

### Task 7: Mobile stack controls

**Files:**

- Create: `apps/mobile/src/features/threads/git/GitStackSheet.tsx`
- Modify: `apps/mobile/src/features/threads/git/GitOverviewSheet.tsx`
- Modify: `apps/mobile/src/features/threads/ThreadGitControls.tsx`
- Modify: `apps/mobile/src/features/threads/GitActionProgressOverlay.tsx`
- Modify: `apps/mobile/src/state/use-selected-thread-git-actions.ts`
- Modify: `apps/mobile/src/Stack.tsx`
- Modify: `apps/mobile/src/features/threads/git/git-overview-navigation.ts`
- Modify: `apps/mobile/src/features/threads/git/git-overview-navigation.test.ts`

**Interfaces:**

- Consumes: Task 4 shared state.
- Produces: current stack sheet with view, switch, start-next, share, refresh, merge confirmation, and open-PR actions.

- [ ] **Step 1: Write failing navigation tests**

Cover stack summary visibility, opening the stack sheet, selecting a local step, opening a remote PR, and returning to Git overview.

- [ ] **Step 2: Run tests and verify failure**

Run: `corepack pnpm exec vp test run apps/mobile/src/features/threads/git/git-overview-navigation.test.ts`

- [ ] **Step 3: Add the compact stack sheet**

Reuse existing Git sheet components, confirmation sheet, progress overlay, icons, and theme tokens. Keep all touch targets at least 44 by 44 pixels. Do not add mobile PR review.

- [ ] **Step 4: Run mobile test, lint, and typecheck**

Run: `corepack pnpm exec vp test run apps/mobile/src/features/threads/git/git-overview-navigation.test.ts`

Run: `corepack pnpm exec vp lint apps/mobile/src/features/threads/git/GitStackSheet.tsx apps/mobile/src/features/threads/git/GitOverviewSheet.tsx apps/mobile/src/features/threads/ThreadGitControls.tsx apps/mobile/src/state/use-selected-thread-git-actions.ts`

Run: `corepack pnpm --filter @t3tools/mobile typecheck`

- [ ] **Step 5: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): add stack Git controls"
```

### Task 8: Agent freshness, docs, and final verification

**Files:**

- Modify only if needed by failing freshness tests: `apps/server/src/orchestration/Layers/CheckpointReactor.ts`
- Modify only if needed by failing freshness tests: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- Modify: `docs/user/source-control.md`
- Create: `docs/internals/pull-request-stacks.md`
- Modify: `docs/internals/glossary.md`

**Interfaces:**

- Consumes: all prior tasks.
- Produces: refreshed stack state after agent Git changes and user-facing documentation.

- [ ] **Step 1: Prove whether existing Git refresh invalidates stack state**

Write one focused test that completes an agent/checkpoint Git change and observes a fresh current-stack request. If existing invalidation already covers it, keep reactor files unchanged.

- [ ] **Step 2: Add only the missing invalidation**

Do not add provider-specific instructions. PR-to-thread handoff remains the agent boundary.

- [ ] **Step 3: Document setup and behavior**

User docs cover install, start, next step, share, refresh, merge, unstack, and errors in shipped-product language. Internal docs cover contracts, server commands, cache boundaries, and remote execution.

- [ ] **Step 4: Run the full focused verification set**

Run every test file added or changed in Tasks 1 through 8 in one `vp test run` command.

Run package typechecks for contracts, client-runtime, server, web, and mobile.

Run targeted lint on every changed TypeScript and TSX file.

Run `corepack pnpm exec vp fmt --check` on the changed files if supported; otherwise run the repository formatter once and inspect the diff.

- [ ] **Step 5: Run clean-code and test guard reviews**

Check the full diff for unnecessary abstractions, copied logic, generic names, broad catches, dead exports, long functions, and tests that assert mocks instead of behavior. Fix every critical or important finding and rerun focused verification.

- [ ] **Step 6: Commit docs or final corrections**

```bash
git add docs apps packages
git commit -m "docs: explain stacked pull requests"
```

### Task 9: Push and open the draft pull request

**Files:**

- No source files.

**Interfaces:**

- Produces: one draft PR from `feat/stacked-pull-requests` to upstream `main`.

- [ ] **Step 1: Rebase onto fresh upstream main**

Fetch `origin/main`. Confirm worktree clean. Rebase feature branch. Rerun focused verification after any changed base.

- [ ] **Step 2: Push to the writable fork**

```bash
git push -u fork feat/stacked-pull-requests
```

- [ ] **Step 3: Open draft PR**

Use a conventional title. Body states the problem, the small native solution, tested surfaces, and ends with the model and harness used.

- [ ] **Step 4: Verify PR state**

Confirm draft status, base `pingdotgg/t3code:main`, head `Bil0000:feat/stacked-pull-requests`, and current CI checks.
