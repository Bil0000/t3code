import "~/index.css";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const mocks = vi.hoisted(() => ({
  update: vi.fn<(input: unknown) => Promise<{ _tag: "Success" | "Failure" }>>(),
  notify: vi.fn(),
}));
vi.mock(
  import("~/state/pullRequests"),
  () => ({ pullRequestEnvironment: { update: {} } }) as never,
);
vi.mock(
  import("~/state/use-atom-command"),
  () => ({ useAtomCommand: () => mocks.update }) as never,
);

vi.mock(import("../ui/toast"), () => ({ toastManager: { add: mocks.notify } }) as never);
vi.mock(import("~/state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryServerKeybindingsAtom: Atom.make([]) } as never;
});
vi.mock(import("./PullRequestThreadLinks"), () => ({ PullRequestThreadLinks: () => null }));
vi.mock(
  import("./PullRequestDetailActions"),
  () => ({ ActOnEnvironmentPicker: () => null }) as never,
);

import { render } from "../../../test/render";
import { PullRequestActionsMenu } from "./PullRequestActionsMenu";

const reference = { projectId: ProjectId.make("project"), repository: "owner/repo", number: 7 };
const environmentId = EnvironmentId.make("environment");

function setup() {
  mocks.update.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.notify.mockReset();
  const onSaved = vi.fn();
  const control = (allowed = true, enabled = true) => (
    <PullRequestActionsMenu
      environmentId={environmentId}
      reference={reference}
      pullRequestKey="owner/repo/7"
      detail={{
        url: "https://github.com/owner/repo/pull/7",
        state: "open",
        isDraft: false,
        headBranch: "feature",
        maintainerCanModify: enabled,
        capabilities: {
          diff: true,
          comment: true,
          actions: [],
          mergeMethods: [],
          search: true,
          review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
          reviewers: { request: true, listCandidates: true },
          edit: { changeRequest: true, comment: true, maintainerEdits: true },
        },
        viewerPermissions: {
          actions: [],
          comment: true,
          resolve: true,
          verdicts: [],
          requestReviewers: true,
          maintainerEdits: true,
        },
      }}
      terminology={sourceControlClients.get("github").changeRequest}
      linkThreadRef={null}
      onThreadPickerOpenChange={() => {}}
      refreshing={false}
      refreshFromHost={async () => {}}
      handoff={null}
      attachesToComposer={false}
      askAboutPullRequest={() => {}}
      explainPullRequest={() => {}}
      canFixFindings={false}
      startFixFindings={() => {}}
      handoffLabels={{ fixFindings: "Fix review findings" }}
      canWriteGuide={false}
      guideRunning={false}
      guideWritten={false}
      writeGuide={() => {}}
      pickableEnvironments={[]}
      actingEnvironmentId={environmentId}
      onActingEnvironmentChange={() => {}}
      can={() => false}
      autoMergeArmed={false}
      showsDraftToggle={false}
      showsMergeNow={false}
      showsAutoMerge={false}
      showsMergeMethods={false}
      allowedMergeMethods={[]}
      selectedMergeMethod="squash"
      onSelectMergeMethod={() => {}}
      showsDeleteBranch={false}
      environmentConnected={true}
      canWriteSourceControl={allowed}
      onMaintainerEditsSaved={onSaved}
      confirmDeleteBranch={async () => {}}
      pendingAction={null}
      perform={async () => true}
      openOnHostText="Open on GitHub"
      copyReference={() => {}}
    />
  );
  return { control, onSaved };
}

it("saves both directions without waiting for a refreshed detail", async () => {
  const { control, onSaved } = setup();
  await using screen = await render(control());
  await screen.getByRole("button", { name: "More pull request actions" }).click();
  expect(document.querySelector('[role="menuitemcheckbox"]')).not.toBeNull();
  const checkbox = page.getByRole("menuitemcheckbox", { name: "Allow edits from maintainers" });
  await expect
    .element(checkbox)
    .toHaveAccessibleDescription(
      "Maintainers can push to this branch. If your fork has workflows, this can also give access to its secrets.",
    );
  await checkbox.click();
  await expect.element(checkbox).not.toBeChecked();
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  await checkbox.click();
  await expect.element(checkbox).toBeChecked();
  expect(mocks.update.mock.calls.map(([input]) => input)).toEqual([
    { environmentId, input: { ...reference, maintainerCanModify: false } },
    { environmentId, input: { ...reference, maintainerCanModify: true } },
  ]);
});

it("locks the control while a save is in flight, including after reopening the menu", async () => {
  const { control } = setup();
  let settle!: (value: { _tag: "Success" }) => void;
  const pending = new Promise<{ _tag: "Success" }>((resolve) => {
    settle = resolve;
  });
  mocks.update.mockReturnValue(pending);
  await using screen = await render(control());
  await screen.getByRole("button", { name: "More pull request actions" }).click();
  const checkbox = page.getByRole("menuitemcheckbox");
  await checkbox.click();
  await expect.element(checkbox).toHaveAttribute("aria-disabled", "true");
  await expect.element(page.getByRole("status")).toHaveTextContent("Saving…");
  await userEvent.keyboard("{Escape}");
  await screen.getByRole("button", { name: "More pull request actions" }).click();
  await expect.element(checkbox).toHaveAttribute("aria-disabled", "true");
  expect(mocks.update).toHaveBeenCalledTimes(1);
  settle({ _tag: "Success" });
  await expect.element(checkbox).not.toHaveAttribute("aria-disabled", "true");
});

it("reports a failed save after closing the menu and lets the user retry", async () => {
  const { control, onSaved } = setup();
  await using screen = await render(control());
  await screen.getByRole("button", { name: "More pull request actions" }).click();
  const checkbox = page.getByRole("menuitemcheckbox");
  await checkbox.click();
  await expect.element(checkbox).not.toBeChecked();
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  let settle!: (value: { _tag: "Failure" }) => void;
  mocks.update.mockReturnValueOnce(
    new Promise<{ _tag: "Failure" }>((resolve) => {
      settle = resolve;
    }),
  );
  await checkbox.click();
  await userEvent.keyboard("{Escape}");
  settle({ _tag: "Failure" });
  await vi.waitFor(() =>
    expect(mocks.notify).toHaveBeenCalledWith({
      type: "error",
      title: "Could not save maintainer access",
      description: "Try again.",
    }),
  );
  await screen.getByRole("button", { name: "More pull request actions" }).click();
  await expect.element(checkbox).not.toBeChecked();
  expect(onSaved).toHaveBeenCalledTimes(1);
  await checkbox.click();
  await expect.element(checkbox).toBeChecked();
});

it("blocks a session without source control write access", async () => {
  const { control } = setup();
  await using screen = await render(control(false));
  await screen.getByRole("button", { name: "More pull request actions" }).click();
  await expect.element(page.getByRole("menuitemcheckbox")).toHaveAttribute("aria-disabled", "true");
  expect(mocks.update).not.toHaveBeenCalled();
});

it("keeps a second save locked when the first save's refresh arrives", async () => {
  const { control, onSaved } = setup();
  await using screen = await render(control());
  await screen.getByRole("button", { name: "More pull request actions" }).click();
  const checkbox = page.getByRole("menuitemcheckbox");
  await checkbox.click();
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  let settle!: (value: { _tag: "Success" }) => void;
  mocks.update.mockReturnValueOnce(
    new Promise<{ _tag: "Success" }>((resolve) => {
      settle = resolve;
    }),
  );
  await checkbox.click();
  await expect.element(checkbox).toHaveAttribute("aria-disabled", "true");
  await screen.rerender(control(true, false));
  await expect.element(checkbox).toHaveAttribute("aria-disabled", "true");
  await expect.element(checkbox).toBeChecked();
  await userEvent.keyboard("{Enter}");
  expect(mocks.update).toHaveBeenCalledTimes(2);
  settle({ _tag: "Success" });
  await expect.element(checkbox).not.toHaveAttribute("aria-disabled", "true");
  await expect.element(checkbox).toBeChecked();
  await screen.rerender(control(true, true));
  await screen.rerender(control(true, false));
  await expect.element(checkbox).not.toBeChecked();
});
