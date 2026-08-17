import { renderToStaticMarkup } from "react-dom/server";
import { SettingsIcon } from "lucide-react";
import { describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../test/reactElementTree";
import { LinearIcon } from "../components/Icons";
import { MenuItem } from "../components/ui/menu";
import { CompactFilterMenu, IssuesColumn, mergeIssueProviderSummaries } from "./_chat.issues";

describe("IssuesColumn", () => {
  it("keeps issue actions in the fixed titlebar", () => {
    const markup = renderToStaticMarkup(
      <IssuesColumn
        refreshing={false}
        onRefresh={() => undefined}
        searchValue=""
        involvement="all"
        state="open"
        host={undefined}
        hostMenuOptions={[]}
        hostMenuAction={undefined}
        onInvolvement={() => undefined}
        onState={() => undefined}
        onHost={() => undefined}
        searchInput={<input aria-label="Search issues" />}
        filtersMenu={<button type="button">Filters</button>}
        selectionControl={<button type="button">Select</button>}
        rightPanelControl={null}
        rightPanelOpen={false}
        listBody={null}
      />,
    );

    expect(markup).toContain(
      "drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center",
    );
    const header = markup.slice(markup.indexOf("<header"), markup.indexOf("</header>"));
    expect(header).toContain(">Select</button>");
    expect(header).not.toContain(">Filters</button>");
  });

  it("keeps provider management in the compact menu", () => {
    const onClick = vi.fn();
    const menu = CompactFilterMenu({
      label: "Filter by provider",
      value: "",
      options: [{ value: "", label: "All providers", Icon: SettingsIcon }],
      onChange: vi.fn(),
      action: { label: "Connect Linear…", onClick },
    });
    const action = visitElements(
      menu,
      (element) => element.type === MenuItem && element.props.children !== undefined,
    );

    expect(action?.props.children).toContain("Connect Linear…");
    expect(visitElements(action, (element) => element.type === LinearIcon)).not.toBeNull();
    (action?.props.onClick as (() => void) | undefined)?.();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("merges a filtered provider answer without dropping other providers", () => {
    const github = {
      kind: "github",
      host: "github.com",
      configured: true,
      searchesOnHost: true,
      projectCount: 1,
      detail: null,
    } as const;
    const staleLinear = {
      kind: "linear",
      host: "linear.app",
      configured: false,
      searchesOnHost: false,
      projectCount: 1,
      detail: null,
    } as const;
    const linear = { ...staleLinear, configured: true } as const;

    expect(mergeIssueProviderSummaries([github, staleLinear], [linear], "linear.app")).toEqual([
      github,
      linear,
    ]);
    expect(mergeIssueProviderSummaries([github], [linear], undefined)).toEqual([linear]);
  });
});
