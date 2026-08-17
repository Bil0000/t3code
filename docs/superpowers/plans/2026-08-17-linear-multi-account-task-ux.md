# Linear Multi-Account and Task UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe multi-account Linear project bindings, repair Linear activity/provider stability, and clarify task generation while preserving the configured text model.

**Architecture:** Store an encrypted credential pool in the existing secret store and project-to-credential/team bindings in server settings. Carry credential identity only through internal issue-provider routing. Keep UI changes inside the existing issue filter, Linear dialog, issue detail, and work-item selection components.

**Tech Stack:** TypeScript, Effect, Effect Schema/RPC, React, Jotai, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-17-linear-multi-account-task-ux-design.md`

## Global Constraints

- Disconnect deletes one Linear key and clears every project binding that uses it.
- Never store API keys in settings or send them back to clients.
- Preserve legacy `linear.api-token` and `projectTeams` users without manual migration.
- Keep one user-facing Linear provider entry.
- Pass `textGenerationModelSelection` unchanged; do not override model, effort, options, context, or fetch concurrency.
- Use existing UI primitives and visual language. Add no dependency.
- Use failing focused tests before production edits.
- Make small conventional commits on PR #6315.

---

### Task 1: Multi-account Linear contracts and server routing

**Files:**

- Modify: `packages/contracts/src/issueTracking.ts`
- Modify: `packages/contracts/src/settings.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `apps/server/src/issue/LinearApi.ts`
- Modify: `apps/server/src/issue/LinearIssueProvider.ts`
- Modify: `apps/server/src/issue/IssueProvider.ts`
- Modify: `apps/server/src/issue/IssueProviderRegistry.ts`
- Modify: `apps/server/src/issue/IssueService.ts`
- Modify: `apps/server/src/ws.ts`
- Test: colocated contract, Linear API/provider, registry, and service tests

**Interfaces:**

- Produces: account-list status, `connect({ token })` append behavior, `disconnect({ credentialId })`, project bindings `{ credentialId, teamKey }`, credential-aware internal provider context.
- Consumes: existing secret store, project IDs, issue adapter interfaces, legacy token and project team settings.

- [ ] **Step 1: Write failing tests**

Cover two saved accounts, legacy read/migration, correct token routing for two projects on `linear.app`, distinct viewer keys, and deleting one credential plus all bindings that reference it.

- [ ] **Step 2: Verify red**

Run the exact changed contract/server test files with `./node_modules/.bin/vp test run <files>` and confirm failures are missing multi-account behavior.

- [ ] **Step 3: Implement minimum contracts and server behavior**

Use one versioned secret JSON credential pool. Probe before save. Add only the credential identity needed by internal adapter routing. Keep legacy reads until migration succeeds.

- [ ] **Step 4: Verify green**

Re-run the same focused tests and affected server/contracts typechecks.

- [ ] **Step 5: Commit**

`feat(issues): support multiple Linear accounts`

### Task 2: Linear connection and provider filter UI

**Files:**

- Modify: `apps/web/src/state/issueTracking.ts`
- Modify: `apps/web/src/components/issue/LinearConnectionDialog.tsx`
- Modify: `apps/web/src/components/issue/IssueListFilters.tsx`
- Modify: `apps/web/src/routes/_chat.issues.tsx`
- Test: matching colocated web tests

**Interfaces:**

- Consumes: Task 1 account-list and disconnect RPC contracts.
- Produces: Add API key form, account-scoped disconnect, project account/team selectors, separate gear action, stable Linear visibility.

- [ ] **Step 1: Write failing tests**

Cover adding instead of replacing, gear accessibility, account-scoped disconnect warning/action, project binding, and a cached pre-connect All response that must not hide Linear after provider switches.

- [ ] **Step 2: Verify red**

Run the exact changed web tests and confirm the old singleton UI/state fails them.

- [ ] **Step 3: Implement minimum UI/state changes**

Use existing dialog, menu, select, button, and icon primitives. Keep provider radio selection and gear as sibling actions so keyboard semantics remain valid.

- [ ] **Step 4: Verify green**

Re-run focused tests plus affected web typecheck.

- [ ] **Step 5: Commit**

`feat(web): manage Linear accounts by project`

### Task 3: Linear activity and provider-specific open labels

**Files:**

- Modify: `apps/server/src/issue/LinearApi.ts`
- Modify: `apps/server/src/issue/LinearIssueProvider.ts`
- Modify: `apps/web/src/components/issue/IssueDetailPanel.tsx`
- Test: `apps/server/src/issue/LinearApi.test.ts`
- Test: affected issue detail tests

**Interfaces:**

- Consumes: Task 1 credential-aware Linear API.
- Produces: valid reaction array queries/parsing and shared `Open on <provider>` issue labels.

- [ ] **Step 1: Write failing tests**

Use API-real reaction arrays. Assert comments and reactions decode, removal lookup uses array selection, and Linear actions render `Open on Linear`.

- [ ] **Step 2: Verify red**

Run both focused test files and confirm the current `{ nodes }` query and fallback label fail.

- [ ] **Step 3: Implement minimum fixes**

Change only reaction query/schema/read shapes and replace the duplicated label map with the existing provider presentation helper.

- [ ] **Step 4: Verify green**

Re-run focused server/web tests and affected typechecks.

- [ ] **Step 5: Commit**

`fix(issues): load Linear activity correctly`

### Task 4: Clear and responsive AI task creation

**Files:**

- Modify: `apps/web/src/components/workItems/WorkItemSelectionBar.tsx`
- Modify: existing selection-bar tests or create a colocated test
- Test: affected text-generation routing test

**Interfaces:**

- Consumes: existing `workItems.generateTask` RPC and configured `textGenerationModelSelection` server path.
- Produces: visible mode descriptions and an immediate draft whose AI replacement is guarded against user edits.

- [ ] **Step 1: Write failing tests**

Assert exact Compound/Subtasks help, immediate thread navigation before generation resolves, no overwrite after a user edit, and unchanged model-selection routing.

- [ ] **Step 2: Verify red**

Run focused tests and confirm old blocking navigation and missing help fail.

- [ ] **Step 3: Implement minimum UI flow**

Open one draft immediately with source links and a generating marker. Replace it only when its content still matches the marker draft. Keep failure text useful and keep selection state recoverable.

- [ ] **Step 4: Verify green**

Re-run focused tests and affected web/server typechecks.

- [ ] **Step 5: Commit**

`fix(issues): make generated tasks feel responsive`

### Task 5: Integrated review and PR update

**Files:**

- Review: all files changed by Tasks 1-4

**Interfaces:**

- Consumes: all prior task commits.
- Produces: reviewed, focused-test-clean PR branch.

- [ ] **Step 1: Run focused verification**

Run every changed test file, affected package typechecks, and `git diff --check`.

- [ ] **Step 2: Review the complete diff**

Check legacy migration, credential isolation, menu keyboard behavior, stale-cache behavior, reaction operations, draft overwrite safety, and unchanged model options.

- [ ] **Step 3: Fix verified findings with tests**

For each real finding, add or adjust the focused failing test before the production fix, then re-run its focused suite.

- [ ] **Step 4: Push**

Push the small commits to the existing PR #6315 branch without force.
