import type { IssuePagedView } from "~/state/issues";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

export function IssueLoadMore({
  page,
  label,
}: {
  page: Pick<
    IssuePagedView<unknown>,
    "hasMore" | "isPending" | "truncated" | "loadMore" | "items" | "error"
  >;
  label: string;
}) {
  return (
    <>
      {page.error !== null && page.items.length > 0 ? (
        <p role="alert" className="text-center text-xs text-muted-foreground">
          More items could not be read. {page.error}
        </p>
      ) : null}
      {page.hasMore ? (
        <div className="flex justify-center">
          <Button size="xs" variant="ghost-muted" disabled={page.isPending} onClick={page.loadMore}>
            {page.isPending ? <Spinner aria-hidden size="sm" /> : null}
            {label}
          </Button>
        </div>
      ) : null}
      {page.truncated && page.items.length > 0 ? (
        <p className="text-center text-2xs text-muted-foreground">
          The tracker returned part of this list. Open it on the host for the rest.
        </p>
      ) : null}
    </>
  );
}
