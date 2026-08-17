import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { IssuesColumn } from "./_chat.issues";

describe("IssuesColumn", () => {
  it("keeps its breadcrumb and controls in one fixed-height row", () => {
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
        filtersMenu={null}
        newIssueControl={<button type="button">New issue</button>}
        rightPanelControl={null}
        rightPanelOpen={false}
        listBody={null}
      />,
    );

    expect(markup).toContain(
      "drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center",
    );
  });
});
