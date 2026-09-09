# Source control

T3 Code integrates with GitHub, GitLab, Bitbucket, and Azure DevOps to clone and publish
repositories, create pull requests, and review changes.

## Connect an account

Install Git and configure authentication on the machine running your T3 Code server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source Control**
and choose **Rescan**.

### GitHub

Install [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, then sign in:

```bash
gh auth login
```

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), then sign in:

```bash
glab auth login
```

### Bitbucket

Set an access token in the server's environment:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
```

Or use an Atlassian account email and API token with read/write access to repositories and pull
requests, plus user read access (`read:user:bitbucket`):

```bash
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

The access token takes precedence if both are configured. Restart the server after changing these
variables.

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

## Clone or publish a project

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository,
adds it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote;
make your first commit before pushing.

## Create a pull request

Use a thread's Git actions to commit, push, and create a pull request. T3 Code can generate commit
messages, review titles, and descriptions from your changes.

Choose the writing style and model in **Settings → Source Control**. **Repository conventions**
uses the project's instructions and recent commit subjects.

## Review and merge

Open **Pull requests** to review changes and comments, request reviewers, check out a branch,
or merge. You can edit review titles and descriptions and your own comments where the host allows it.
GitLab calls these merge requests.

GitHub, GitLab, and Azure DevOps support auto-merge while checks are outstanding. GitHub also
supports approving waiting fork workflows and opening a revert pull request for a merged change.

For Azure DevOps, use the host website to view diffs or change comments. Bitbucket does not support
reopening a declined pull request.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  confirm the running server received the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

### Track Issues Beside the Work

**Browse every tracker in one place**

- The **Issues** page lists issues across all the projects in your environment, filtered by state,
  by whether they are assigned to you, raised by you or mention you, and by project, host or label
- Free-text search asks the host itself, so it finds issues that are not on screen yet
- Supports GitHub Issues, GitLab Issues, Bitbucket Issues, and Azure DevOps work items. What each
  host cannot do is simply not offered rather than failing when pressed

**Read and act on one without leaving T3 Code**

- Open several issues as tabs in the right panel, beside a thread or on the page
- Read the description and the conversation, comment, close (with a reason where the host
  records one), reopen, rename, edit the body, and change labels and assignees
- File a new issue from the **New issue** button
- The change requests that reference an issue are listed on it, and the issues a pull request
  cites or closes are listed on the pull request — either one opens the other beside it

**Hand one to an agent**

- **Solve** starts a thread on the issue, with the issue attached as context
- **Ask** and **Explain** answer a question about the issue without changing any code
- **Add to composer** attaches the issue to a thread you are already in, rather than starting a
  new one
- Everything an issue carries is handed over as untrusted data, so a body written by a stranger on
  a public tracker cannot instruct the agent

### Browse Repository History

Open the right panel menu and choose **Repository**, then select **History** to explore the repository without leaving your thread. The history view shows a connected commit graph, branches, remotes, and tags. Select a ref to focus on it, or choose **All refs** to inspect the wider repository.

Repository History is currently available in web and desktop project views. Mobile keeps its existing Git status and actions, but does not yet include this dense history workspace.

- Search by commit subject, author, ref, or hash. Use the clear control or `Escape` to reset a search.
- Select a commit to view its metadata and changed files, then open the same diff view used elsewhere in T3 Code. History diffs use Git's normal patch output, so they match the familiar command-line review view.
- Copy a full commit hash from a row. When a GitHub repository is connected, issue references in commit subjects open the matching issue.
- Branch rows show ahead and behind counts when an upstream is configured.

For large repositories, history is loaded in pages and the commit list is virtualized. The initial browsing window is intentionally bounded so the right panel remains responsive; select a branch or search to narrow the result.
