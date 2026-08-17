import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { LayersIcon } from "lucide-react";
import { describe, expect, it, vi } from "vite-plus/test";

import { ListFilterRadioGroup } from "../sourceControl/ListFilterMenu";
import { LinearIcon } from "../Icons";
import { MenuItem } from "../ui/menu";
import { IssueFiltersMenu } from "./IssueListFilters";

function collect(
  node: ReactNode,
  type: ReactElement["type"],
): Array<ReactElement<Record<string, unknown>>> {
  const found: Array<ReactElement<Record<string, unknown>>> = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    if (child.type === type) found.push(child as ReactElement<Record<string, unknown>>);
    found.push(...collect((child.props as { children?: ReactNode }).children, type));
  }
  return found;
}

describe("issue filters", () => {
  it("shows only connected providers and keeps All providers selected by default", () => {
    const menu = IssueFiltersMenu({
      state: "open",
      stateOptions: [],
      onState: vi.fn(),
      involvement: "all",
      involvementOptions: [],
      onInvolvement: vi.fn(),
      hostFilter: {
        host: undefined,
        hostOptions: [
          { value: "", label: "All providers", Icon: LayersIcon },
          { value: "github.com", label: "GitHub", Icon: LayersIcon },
          {
            value: "gitlab.com",
            label: "GitLab",
            Icon: LayersIcon,
            unavailable: "Not authenticated",
          },
        ],
        onHost: vi.fn(),
        onManageLinear: vi.fn(),
      },
      label: undefined,
      labels: [],
      onLabel: vi.fn(),
    } as Parameters<typeof IssueFiltersMenu>[0]);

    const providerGroup = collect(menu, ListFilterRadioGroup).find(
      (item) => item.props.label === "Provider",
    );
    expect(providerGroup?.props.value).toBe("");
    expect(
      (providerGroup?.props.options as ReadonlyArray<{ value: string }> | undefined)?.map(
        (item) => item.value,
      ),
    ).toEqual(["", "github.com"]);
    const connectItem = collect(menu, MenuItem)[0];
    expect(Children.toArray(connectItem?.props.children as ReactNode)).toContain("Connect Linear…");
    expect(collect(connectItem, LinearIcon)).toHaveLength(1);
  });

  it("offers Linear settings as a separate menu item when connected", () => {
    const onManageLinear = vi.fn();
    const menu = IssueFiltersMenu({
      state: "open",
      stateOptions: [],
      onState: vi.fn(),
      involvement: "all",
      involvementOptions: [],
      onInvolvement: vi.fn(),
      hostFilter: {
        host: undefined,
        hostOptions: [
          { value: "", label: "All providers", Icon: LayersIcon },
          { value: "linear.app", label: "Linear", Icon: LayersIcon },
        ],
        onHost: vi.fn(),
        onManageLinear,
      },
      label: undefined,
      labels: [],
      onLabel: vi.fn(),
    } as Parameters<typeof IssueFiltersMenu>[0]);

    const item = collect(menu, MenuItem).find((candidate) =>
      Children.toArray(candidate.props.children as ReactNode).includes("Linear settings…"),
    );
    expect(item).toBeDefined();
    expect(collect(item, LinearIcon)).toHaveLength(1);
    (item?.props.onClick as (() => void) | undefined)?.();
    expect(onManageLinear).toHaveBeenCalledOnce();
  });
});
