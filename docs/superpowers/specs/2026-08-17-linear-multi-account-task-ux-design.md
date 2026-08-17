# Linear Multi-Account and Task UX Design

## Goal

Let one T3 environment store multiple Linear API keys, bind each T3 project to one Linear account and team, keep provider filters stable, repair Linear activity, and make AI task creation clearer without changing the configured text model or its options.

## Linear accounts and projects

- A new API key is probed before storage, then added as a separate saved Linear account.
- The account identity returned by Linear is the stable credential ID.
- Each T3 project stores `{ credentialId, teamKey }`.
- A project can use only one Linear account and team at a time.
- Disconnect deletes the selected account key entirely and clears every project binding that uses it. There is no separate “remove key” action.
- Existing single-key and `projectTeams` settings remain readable and migrate without user work.
- Secret values stay in the server secret store. Settings contain IDs and team keys only.

## Provider routing

- Internal issue-provider context carries the credential ID so accounts on `linear.app` never share viewer identity or request caches.
- User-facing provider filters still show one Linear entry.
- Linear menu visibility comes from saved connection/project state, not transient issue-list health.
- Switching between GitHub, Linear, and All cannot hide a connected Linear provider because an older list response was cached.

## Linear dialog

- A connected Linear row has a separate gear action with an accessible `Linear settings` label.
- The dialog has an “Add API key” form and lists saved accounts.
- Each project chooses an account/team binding.
- Disconnect is attached to an account and warns that the key and all project links using it will be removed.

## Activity and host labels

- Linear reactions use the current GraphQL array shape. This repairs Comments, Timeline, and reaction removal.
- Issue actions say `Open on Linear`. Other providers keep their provider names through the shared presentation helper.

## AI task creation

- Task generation continues to use `textGenerationModelSelection` exactly as configured, including model, effort, and provider options.
- No hidden model, effort, context, or concurrency override is added.
- The UI opens the task draft immediately and applies AI output only if the user has not edited that draft. This improves perceived speed without overwriting work.
- Compound help: “One task that merges overlap and orders dependencies.”
- Subtasks help: “One parent task split into ordered child steps.”

## Verification

- Contract migration and multi-account routing tests.
- Dialog/filter tests for add, gear, disconnect, and provider stability.
- Linear API activity tests using real GraphQL reaction array shapes.
- Task selection tests for configured-model preservation, early navigation, and edit-safe AI completion.
- Focused typechecks and tests only; no repository-wide checks.
