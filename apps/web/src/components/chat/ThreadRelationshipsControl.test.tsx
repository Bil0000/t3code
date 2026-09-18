import { describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadId } from "@t3tools/contracts";

import { makeThreadFixture } from "../../test-fixtures";
import {
  resolveThreadLineageWindow,
  ThreadLineageRowList,
  ThreadRelationshipsPanel,
} from "./ThreadRelationshipsControl";

const state = vi.hoisted(() => ({ threads: [] as ReturnType<typeof makeThreadFixture>[] }));
vi.mock("../../state/entities", () => ({
  useThreadProjection: () => null,
  useThreadShells: () => state.threads,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots: [] }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

const rows = Array.from({ length: 20 }, (_, index) => `row-${index}`);

function renderRowList(visibleCount: number) {
  const { visibleRows, hiddenCount } = resolveThreadLineageWindow(rows, visibleCount);
  return renderToStaticMarkup(
    <ThreadLineageRowList hiddenCount={hiddenCount} onShowMore={() => {}}>
      {visibleRows.map((row) => (
        <li key={row}>{row}</li>
      ))}
    </ThreadLineageRowList>,
  );
}

describe("thread lineage row list", () => {
  it.each([0, 1, 8])("counts %i running children across all pages", (runningCount) => {
    const parent = makeThreadFixture();
    state.threads = [
      parent,
      ...Array.from({ length: runningCount + 2 }, (_, index) => {
        const child = makeThreadFixture({
          id: ThreadId.make(`child-${index}`),
          lineage: {
            rootThreadId: parent.id,
            parentThreadId: parent.id,
            relationshipToParent: index === runningCount + 1 ? "fork" : "subagent",
          },
        });
        return {
          ...child,
          source: {
            ...child.source,
            status: index === runningCount ? ("idle" as const) : ("running" as const),
          },
        };
      }),
    ];
    const markup = renderToStaticMarkup(
      <ThreadRelationshipsPanel environmentId={parent.environmentId} threadId={parent.id} />,
    );
    const heading = /<h3[^>]*>(.*?)<\/h3>/.exec(markup)?.[1];
    expect(heading).toBe(runningCount ? `Lineage · ${runningCount} running` : "Lineage");
  });

  it("shows six rows before the first expansion", () => {
    const { visibleRows, hiddenCount } = resolveThreadLineageWindow(rows, 6);

    expect(visibleRows).toEqual(rows.slice(0, 6));
    expect(hiddenCount).toBe(14);
  });

  it("offers one page at a time", () => {
    expect(renderRowList(6)).toContain("Show 12 more");
    expect(renderRowList(6 + 12)).toContain("Show 2 more");
  });

  it("omits the expansion affordance when everything fits", () => {
    const markup = renderRowList(rows.length);

    expect(markup).not.toContain("more");
    expect(resolveThreadLineageWindow(rows.slice(0, 6), 6).hiddenCount).toBe(0);
  });

  it("keeps the rows in a bounded, labelled scroll region and the button outside it", () => {
    const markup = renderRowList(6);
    const list = /<ul([^>]*)>/.exec(markup)?.[1] ?? "";

    expect(list).toContain('aria-label="Related threads"');
    expect(list).toContain("max-h-[13.5rem]");
    expect(list).toContain("overflow-y-auto");
    expect(list).toContain("overscroll-contain");
    expect(markup.indexOf("</ul>")).toBeLessThan(markup.indexOf("<button"));
  });
});
