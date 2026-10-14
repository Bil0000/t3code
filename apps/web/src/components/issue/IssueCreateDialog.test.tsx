import { EnvironmentId, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("~/state/issues", () => ({
  issueEnvironment: { create: { permissionAtom: () => null } },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, isPending: false, error: null }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.create }));
vi.mock("../ui/dialog", () => ({
  Dialog: "div",
  DialogDescription: "div",
  DialogFooter: "div",
  DialogHeader: "div",
  DialogPanel: "div",
  DialogPopup: "div",
  DialogTitle: "div",
}));
vi.mock("../ui/button", () => ({ Button: "button", InlineButton: "a" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/label", () => ({ Label: "label" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "option",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "div",
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { IssueCreateDialog, type IssueCreateScope } from "./IssueCreateDialog";

const scope = (projectId: string): IssueCreateScope => ({
  environmentId: EnvironmentId.make("env"),
  projectTitle: projectId,
  templates: false,
  scope: {
    projectId: ProjectId.make(projectId),
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "acme/web",
  },
});
const [a, b, c] = [scope("a"), scope("b"), scope("c")];
let renderer: ReactTestRenderer;

const render = (scopes: ReadonlyArray<IssueCreateScope>) =>
  act(async () => {
    const dialog = (
      <IssueCreateDialog open scopes={scopes} onOpenChange={vi.fn()} onCreated={vi.fn()} />
    );
    if (renderer === undefined) renderer = create(dialog);
    else renderer.update(dialog);
  });
const choose = (project: IssueCreateScope) =>
  act(async () => {
    const item = renderer.root
      .findAllByType("option")
      .find((option) => option.props.children[0] === project.projectTitle)!;
    renderer.root
      .findByProps({ id: "issue-create-scope" })
      .parent!.props.onValueChange(item.props.value);
  });
const createButton = () =>
  renderer.root.findAllByType("button").find((button) => button.props.children === "Create issue")!;
const submit = () => act(async () => createButton().props.onClick());

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.create.mockResolvedValue({ _tag: "Success", value: { displayKey: "#1" } });
  renderer = undefined!;
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

it("keeps the chosen project when the list reorders", async () => {
  await render([a, b]);
  await choose(b);
  await act(async () => {
    renderer.root.findByProps({ id: "issue-create-title" }).props.onChange({
      target: { value: "Bug" },
    });
  });
  await render([b, a]);
  await submit();
  expect(state.create.mock.calls[0]?.[0].input.projectId).toBe("b");
});

it("holds the draft without a destination until a removed project is replaced by choice", async () => {
  await render([a, b]);
  await act(async () => {
    renderer.root.findByProps({ id: "issue-create-title" }).props.onChange({
      target: { value: "Draft" },
    });
  });
  await render([b, c]);
  expect(createButton().props.disabled).toBe(true);
  await submit();
  expect(state.create).not.toHaveBeenCalled();
  expect(renderer.root.findByProps({ id: "issue-create-title" }).props.value).toBe("Draft");
  await render([c]);
  expect(createButton().props.disabled).toBe(true);
  await choose(c);
  expect(createButton().props.disabled).toBe(false);
  await submit();
  expect(state.create).toHaveBeenCalledOnce();
  expect(state.create.mock.calls[0]?.[0].input).toMatchObject({ projectId: "c", title: "Draft" });
});
