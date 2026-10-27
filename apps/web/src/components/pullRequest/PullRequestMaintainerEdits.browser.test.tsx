import "~/index.css";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
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

import { render } from "../../../test/render";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";

import { PullRequestMaintainerEdits } from "./PullRequestMaintainerEdits";

const reference = { projectId: ProjectId.make("project"), repository: "owner/repo", number: 7 };
const environmentId = EnvironmentId.make("environment");

function setup() {
  mocks.update.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.notify.mockReset();
  const onSaved = vi.fn();
  const control = (allowed = true) => (
    <Menu>
      <MenuTrigger>More pull request actions</MenuTrigger>
      <MenuPopup keepMounted>
        <PullRequestMaintainerEdits
          environmentId={environmentId}
          reference={reference}
          enabled={true}
          allowed={allowed}
          onSaved={onSaved}
        />
      </MenuPopup>
    </Menu>
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
