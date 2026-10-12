import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "~/test/reactHookHarness";
import { visitElements } from "~/test/reactElementTree";
import { IssueCreateDialog } from "./IssueCreateDialog";
import { DialogPopup } from "../ui/dialog";

const createIssue = vi.hoisted(() => vi.fn());
let pending = false;
let blankIssuesEnabled = true;
let allowed = true;
let offerExtras: Record<string, unknown> = {};
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return {
    ...actual,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => allowed }));
vi.mock("~/state/entities", () => ({
  useProjects: () => [{ id: "p1", repositoryIdentity: { displayName: "acme/web" } }],
}));
vi.mock("~/state/issues", () => ({
  issueEnvironment: { templates: () => "templates", create: { permissionAtom: () => null } },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: pending ? null : { templates: [], contactLinks: [], blankIssuesEnabled, ...offerExtras },
    error: null,
    isPending: pending,
  }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => createIssue }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

function renderDialog() {
  hooks.beginRender();
  return IssueCreateDialog({
    open: true,
    onOpenChange: vi.fn(),
    environmentId: "local" as EnvironmentId,
    projects: [{ id: "p1" as ProjectId, title: "Web", workspaceRoot: "/w" }],
    projectId: "p1" as ProjectId,
    onCreated: vi.fn(),
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  pending = false;
  blankIssuesEnabled = true;
  allowed = true;
  offerExtras = {};
});

const byId = (id: string) => visitElements(renderDialog(), (element) => element.props.id === id);
const type = (id: string, value: string) =>
  (byId(id)!.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value },
  });
const pressCreate = () => {
  const popup = visitElements(renderDialog(), (element) => element.type === DialogPopup)!;
  (popup.props.onKeyDown as (event: unknown) => void)({
    key: "Enter",
    ctrlKey: true,
    preventDefault: vi.fn(),
  });
};
const success = { _tag: "Success", value: { number: 1, url: "https://dev.azure.com/a/b/1" } };

it("files an Azure work item only once a returned type is chosen, and sends that type", async () => {
  hooks.reset();
  vi.stubGlobal("navigator", { platform: "Linux" });
  createIssue.mockResolvedValue(success);
  offerExtras = { workItemTypes: ["Bug", "Task"] };
  type("issue-title", "Broken build");
  pressCreate();
  expect(createIssue).not.toHaveBeenCalled();
  const picker = visitElements(
    renderDialog(),
    (element) =>
      typeof element.props.onValueChange === "function" &&
      visitElements(element.props.children, (child) => child.props.value === "Task") !== null,
  )!;
  (picker.props.onValueChange as (value: string) => void)("Task");
  pressCreate();
  expect(createIssue).toHaveBeenCalledWith(
    expect.objectContaining({ input: expect.objectContaining({ workItemType: "Task" }) }),
  );
  await createIssue.mock.results[0]!.value;
});

it("offers no form when the host returns no work item types", () => {
  hooks.reset();
  vi.stubGlobal("navigator", { platform: "Linux" });
  offerExtras = { workItemTypes: [] };
  expect(byId("issue-title")).toBeNull();
  pressCreate();
  expect(createIssue).not.toHaveBeenCalled();
});

it("refuses more assignees than the host takes", async () => {
  hooks.reset();
  vi.stubGlobal("navigator", { platform: "Linux" });
  createIssue.mockResolvedValue(success);
  offerExtras = {
    capabilities: { create: true, labels: true, assignees: true, maxAssignees: 1 },
  };
  type("issue-title", "Broken build");
  type("issue-assignees", "ada@example.com, grace@example.com");
  pressCreate();
  expect(createIssue).not.toHaveBeenCalled();
  type("issue-assignees", "ada@example.com");
  pressCreate();
  expect(createIssue).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ assignees: ["ada@example.com"] }),
    }),
  );
  expect(createIssue.mock.calls[0]![0].input).not.toHaveProperty("workItemType");
  await createIssue.mock.results[0]!.value;
});

it("blocks the submit shortcut while templates load and when blank issues are disabled", async () => {
  hooks.reset();
  vi.stubGlobal("navigator", { platform: "Linux" });
  createIssue.mockResolvedValue({
    _tag: "Success",
    value: { number: 1, url: "https://github.com/acme/web/issues/1" },
  });
  const title = visitElements(renderDialog(), (element) => element.props.id === "issue-title")!;
  (title.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: "Test issue" },
  });
  const submit = () => {
    const popup = visitElements(renderDialog(), (element) => element.type === DialogPopup)!;
    (popup.props.onKeyDown as (event: unknown) => void)({
      key: "Enter",
      ctrlKey: true,
      preventDefault: vi.fn(),
    });
  };
  allowed = false;
  submit();
  expect(createIssue).not.toHaveBeenCalled();
  allowed = true;
  pending = true;
  submit();
  expect(createIssue).not.toHaveBeenCalled();
  pending = false;
  blankIssuesEnabled = false;
  submit();
  expect(createIssue).not.toHaveBeenCalled();
  blankIssuesEnabled = true;
  submit();
  expect(createIssue).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ title: "Test issue", repository: "acme/web" }),
    }),
  );
  await createIssue.mock.results[0]!.value;
});
