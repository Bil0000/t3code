import type { ProjectId } from "@t3tools/contracts";
import { CircleIcon } from "lucide-react";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { DetailTabStrip } from "./DetailTabStrip";
import { EntityPicker } from "./EntityPicker";
import { ListFilterRadioGroup, ListProjectFilterGroup, ListSearchInput } from "./ListFilterMenu";

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
  it("keeps the accessible search label separate from its hint", () => {
    const input = ListSearchInput({
      label: "Search pull requests",
      placeholder: "Search pull requests, or label:bug",
      value: "",
      onChange: vi.fn(),
    });
    const field = Children.toArray(input.props.children).find(
      (child) =>
        isValidElement(child) &&
        (child.props as { readonly "aria-label"?: string })["aria-label"] ===
          "Search pull requests",
    ) as ReactElement<{
      readonly "aria-label": string;
      readonly placeholder: string;
      readonly type: string;
    }>;

    expect(field.props["aria-label"]).toBe("Search pull requests");
    expect(field.props.placeholder).toBe("Search pull requests, or label:bug");
    expect(field.props.type).toBe("search");
  });

  it("uses the compact input primitive in entity pickers", () => {
    const picker = EntityPicker({
      icon: null,
      label: "Assign people",
      allowed: true,
      disallowedReason: "Unavailable",
      open: true,
      onOpenChange: vi.fn(),
      searchLabel: "Search people",
      query: "",
      onQueryChange: vi.fn(),
      message: null,
      note: null,
      children: null,
    });
    const popup = Children.toArray(picker.props.children).find(
      (child) =>
        isValidElement(child) &&
        (child.props as { readonly className?: string }).className === "w-72 p-0",
    ) as ReactElement<{ readonly children: ReactNode }>;
    const frame = Children.toArray(popup.props.children)[0] as ReactElement<{
      readonly children: ReactNode;
    }>;
    const field = Children.only(frame.props.children) as ReactElement<{
      readonly "aria-label": string;
      readonly size: string;
    }>;

    expect(field.type).not.toBe("input");
    expect(field.props["aria-label"]).toBe("Search people");
    expect(field.props.size).toBe("compact");
  });

  it("hides the native scrollbar on detail tabs", () => {
    const strip = DetailTabStrip({
      label: "Pull request tabs",
      tabs: [{ value: "summary", label: "Summary" }],
      active: "summary",
      onSelect: vi.fn(),
    });

    expect(strip.props.className).toContain("[scrollbar-width:none]");
    expect(strip.props.className).toContain("[&::-webkit-scrollbar]:hidden");
  });
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
