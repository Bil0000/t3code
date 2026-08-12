import type { ProjectId } from "@t3tools/contracts";
import { CircleIcon } from "lucide-react";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { ListFilterRadioGroup, ListProjectFilterGroup } from "./ListFilterMenu";

function findValueChange(
  node: ReactNode,
):
  | ReactElement<{ readonly children?: ReactNode; readonly onValueChange: (value: string) => void }>
  | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const props = child.props as {
      readonly children?: ReactNode;
      readonly onValueChange?: (value: string) => void;
    };
    if (props.onValueChange) {
      return child as ReactElement<{
        readonly children?: ReactNode;
        readonly onValueChange: (value: string) => void;
      }>;
    }
    const nested = findValueChange(props.children);
    if (nested) return nested;
  }
  return undefined;
}

describe("list filter menu", () => {
  it("does not emit a change when the selected option is chosen again", () => {
    const onChange = vi.fn();
    const group = findValueChange(
      ListFilterRadioGroup({
        label: "State",
        value: "open",
        options: [
          { value: "open", label: "Open", Icon: CircleIcon },
          { value: "closed", label: "Closed", Icon: CircleIcon },
        ],
        onChange,
      }),
    );
    expect(group).toBeDefined();

    group?.props.onValueChange("open");
    expect(onChange).not.toHaveBeenCalled();

    group?.props.onValueChange("closed");
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("closed");
  });

  it("does not emit a change when the selected project is chosen again", () => {
    const projectId = "project-1" as ProjectId;
    const onProject = vi.fn();
    const group = findValueChange(
      ListProjectFilterGroup({
        environmentId: null,
        projects: [{ id: projectId, title: "T3 Code", workspaceRoot: "/work/t3code" }],
        projectId,
        unavailable: new Map(),
        onProject,
      }),
    );
    expect(group).toBeDefined();

    group?.props.onValueChange(projectId);
    expect(onProject).not.toHaveBeenCalled();

    group?.props.onValueChange("all");
    expect(onProject).toHaveBeenCalledWith(undefined);
  });
});
