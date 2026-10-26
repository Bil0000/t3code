import "~/index.css";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  update: vi.fn<(input: unknown) => Promise<{ _tag: "Success" | "Failure" }>>(),
}));
vi.mock(
  import("~/state/pullRequests"),
  () => ({ pullRequestEnvironment: { update: {} } }) as never,
);
vi.mock(
  import("~/state/use-atom-command"),
  () => ({ useAtomCommand: () => mocks.update }) as never,
);

import { render } from "../../../test/render";
import { PullRequestMaintainerEdits } from "./PullRequestMaintainerEdits";

const reference = { projectId: ProjectId.make("project"), repository: "owner/repo", number: 7 };
const environmentId = EnvironmentId.make("environment");

function setup() {
  mocks.update.mockReset().mockResolvedValue({ _tag: "Success" });
  const onSaved = vi.fn();
  const control = (allowed = true) => (
    <PullRequestMaintainerEdits
      environmentId={environmentId}
      reference={reference}
      enabled={true}
      allowed={allowed}
      onSaved={onSaved}
    />
  );
  return { control, onSaved };
}

it("saves both directions without waiting for a refreshed detail", async () => {
  const { control, onSaved } = setup();
  await using screen = await render(control());
  const checkbox = screen.getByRole("checkbox", { name: "Allow edits from maintainers" });
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

it("locks the control while a save is in flight", async () => {
  const { control } = setup();
  let settle!: (value: { _tag: "Success" }) => void;
  const pending = new Promise<{ _tag: "Success" }>((resolve) => {
    settle = resolve;
  });
  mocks.update.mockReturnValue(pending);
  await using screen = await render(control());
  const checkbox = screen.getByRole("checkbox");
  await checkbox.click();
  await expect.element(checkbox).toBeDisabled();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Saving…");
  expect(mocks.update).toHaveBeenCalledTimes(1);
  settle({ _tag: "Success" });
  await expect.element(checkbox).toBeEnabled();
});

it("restores the last saved value after a failed save and lets the user retry", async () => {
  const { control, onSaved } = setup();
  await using screen = await render(control());
  const checkbox = screen.getByRole("checkbox");
  await checkbox.click();
  await expect.element(checkbox).not.toBeChecked();
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  mocks.update.mockResolvedValueOnce({ _tag: "Failure" });
  await checkbox.click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Could not save maintainer access. Try again.");
  await expect.element(checkbox).not.toBeChecked();
  expect(onSaved).toHaveBeenCalledTimes(1);
  await checkbox.click();
  await expect.element(checkbox).toBeChecked();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
});

it("blocks a session without source control write access", async () => {
  const { control } = setup();
  await using screen = await render(control(false));
  await expect.element(screen.getByRole("checkbox")).toBeDisabled();
  expect(mocks.update).not.toHaveBeenCalled();
});
