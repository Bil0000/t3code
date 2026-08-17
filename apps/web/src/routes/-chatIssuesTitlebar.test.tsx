import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { IssuesColumn } from "./_chat.issues";

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
});
