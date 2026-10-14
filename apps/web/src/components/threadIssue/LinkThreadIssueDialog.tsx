import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useEnvironmentScope } from "~/state/session";
import {
  threadIssueKeysEqual,
  type IssueRef,
  type IssueListResult,
  type IssueListEntry,
  type IssueListCursors,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useThreadShell } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { mergeIssueListPage, issueListCursorsOn } from "@t3tools/client-runtime/state/issues";
import { threadEnvironment } from "~/state/threads";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { useDebouncedValue } from "~/state/queries";
import { useAtomCommand } from "~/state/use-atom-command";
import { issueTrackerPresentation, IssueStateGlyph } from "../issue/issuePresentation";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const linkThreadIssueDialogAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("thread-issues:link-dialog-thread"),
);

export function openLinkThreadIssueDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(linkThreadIssueDialogAtom, threadRef);
}

export function LinkThreadIssueDialogHost() {
  const threadRef = useAtomValue(linkThreadIssueDialogAtom);
  if (threadRef === null) return null;
  return (
    <LinkThreadIssueDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(linkThreadIssueDialogAtom, null)}
    />
  );
}

type IssueSource = NonNullable<IssueListResult["sources"]>[number];
const sourceValue = (source: IssueSource) =>
  JSON.stringify([source.tracker, source.host, source.scope]);

function LinkThreadIssueDialog({
  threadRef,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  onClose: () => void;
}) {
  const environmentId = threadRef.environmentId;
  const thread = useThreadShell(threadRef);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), 250);
  const baseInput = {
    state: "all" as const,
    projectId: thread?.projectId,
    ...(debouncedQuery ? { query: debouncedQuery.slice(0, 200) } : {}),
    limit: 50,
  };
  const list = useEnvironmentQuery(
    thread ? issueEnvironment.list({ environmentId, input: baseInput }) : null,
  );
  const sources = list.data?.sources ?? [];
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const source =
    sources.find((candidate) => sourceValue(candidate) === selectedSource) ?? sources[0] ?? null;
  const [pages, setPages] = useState<{
    seed: IssueListResult;
    entries: ReadonlyArray<IssueListEntry>;
    cursors: IssueListCursors;
  } | null>(null);
  const held = pages?.seed === list.data ? pages : null;
  const candidates = mergeIssueListPage(list.data?.entries ?? [], held?.entries ?? []).filter(
    (entry) =>
      source !== null &&
      entry.tracker === source.tracker &&
      entry.host === source.host &&
      entry.scope === source.scope &&
      !(thread?.issues ?? []).some((link) => threadIssueKeysEqual(link, entry)),
  );
  const nextCursors = source
    ? issueListCursorsOn(held?.cursors ?? list.data?.nextCursors ?? {}, source.host, source.tracker)
    : {};
  const hasMore = Object.keys(nextCursors).length > 0;
  const loadPage = useAtomCommand(issueEnvironment.listPage, { reportFailure: false });
  const [listPending, setListPending] = useState(false);
  const link = useAtomCommand(threadEnvironment.linkIssue, { reportFailure: false });
  const canLink = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolveUrl = useAtomCommand(issueEnvironment.resolveUrl, { reportFailure: false });
  const [nativeUrl, setNativeUrl] = useState("");
  const [directScope, setDirectScope] = useState("");
  const [directKey, setDirectKey] = useState("");
  const directRef: (IssueRef & { host: string }) | null =
    source && directKey.trim()
      ? {
          projectId: source.projectId,
          tracker: source.tracker,
          host: source.host,
          scope: directScope.trim() || source.scope,
          key: directKey.trim().replace(/^#/, ""),
        }
      : null;

  const loadMore = async () => {
    if (!list.data || !hasMore || listPending) return;
    const seed = list.data;
    setListPending(true);
    const result = await loadPage({ environmentId, input: { ...baseInput, cursors: nextCursors } });
    setListPending(false);
    if (result._tag === "Failure") {
      setError(formatEnvironmentQueryError(result.cause));
      return;
    }
    setPages({
      seed,
      entries: mergeIssueListPage(held?.entries ?? [], result.value.entries),
      cursors: {
        ...Object.fromEntries(
          Object.entries(held?.cursors ?? seed.nextCursors).filter(
            ([key]) => nextCursors[key] === undefined,
          ),
        ),
        ...result.value.nextCursors,
      },
    });
  };

  const linkRef = async (ref: IssueRef & { host: string }, nativeUrl?: string) => {
    if (pendingKey !== null) return;
    setPendingKey(ref.key);
    setError(null);
    let url = nativeUrl;
    if (url === undefined) {
      const detail = await executeAtomQuery(
        appAtomRegistry,
        issueEnvironment.detail({ environmentId, input: ref }),
        { reportFailure: false },
      );
      if (detail._tag === "Failure") {
        setPendingKey(null);
        setError(formatEnvironmentQueryError(detail.cause));
        return;
      }
      url = detail.value.url;
    }
    const result = await link({
      environmentId,
      input: { threadId: threadRef.threadId, ...ref, host: ref.host, url, source: "manual" },
    });
    setPendingKey(null);
    if (result._tag === "Failure") {
      setError(formatEnvironmentQueryError(result.cause));
      return;
    }
    onClose();
  };

  const linkUrl = async () => {
    if (pendingKey !== null || !nativeUrl.trim()) return;
    setPendingKey("url");
    setError(null);
    const resolved = await resolveUrl({
      environmentId,
      input: { url: nativeUrl.trim(), ...(thread ? { projectId: thread.projectId } : {}) },
    });
    if (resolved._tag === "Failure") {
      setPendingKey(null);
      setError(formatEnvironmentQueryError(resolved.cause));
      return;
    }
    const result = await link({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        ...resolved.value,
        url: nativeUrl.trim(),
        source: "manual",
      },
    });
    setPendingKey(null);
    if (result._tag === "Failure") {
      setError(formatEnvironmentQueryError(result.cause));
      return;
    }
    onClose();
  };

  const emptyMessage =
    list.data === null && list.isPending
      ? "Loading issues…"
      : (list.error ??
        (sources.length === 0
          ? "This project has no issue tracker. Connect one in Settings › Source control."
          : candidates.length === 0
            ? "No issues to link."
            : null));

  return (
    <Dialog open onOpenChange={(open) => (open || pendingKey !== null ? undefined : onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Link issue</DialogTitle>
          <DialogDescription>
            Attach an issue from this thread's project. Its state refreshes when you open linked
            issues and after each turn.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-2">
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void linkUrl();
              }}
            >
              <Input
                size="sm"
                aria-label="Issue URL"
                placeholder="Paste an issue URL"
                value={nativeUrl}
                disabled={pendingKey !== null}
                onChange={(event) => setNativeUrl(event.target.value)}
              />
              <Button
                size="sm"
                type="submit"
                variant="outline"
                disabled={!canLink || pendingKey !== null || !nativeUrl.trim()}
              >
                Link URL
              </Button>
            </form>
            <div className="flex gap-2">
              {sources.length > 1 ? (
                <Select
                  value={source === null ? "" : sourceValue(source)}
                  onValueChange={(next) => setSelectedSource(next)}
                >
                  <SelectTrigger size="sm" className="w-44 shrink-0" aria-label="Issue source">
                    <SelectValue>
                      {source ? issueTrackerPresentation(source.tracker).providerName : "Source"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {sources.map((candidate) => (
                      <SelectItem key={sourceValue(candidate)} value={sourceValue(candidate)}>
                        {issueTrackerPresentation(candidate.tracker).providerName}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : null}
              <Input
                autoFocus
                size="sm"
                placeholder={
                  source?.capabilities.search === false ? "Search unavailable" : "Search issues"
                }
                disabled={source === null || source.capabilities.search === false}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                aria-label="Search issues"
              />
            </div>
            {source !== null ? (
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (directRef !== null && canLink && pendingKey === null) void linkRef(directRef);
                }}
              >
                {
                  <Input
                    size="sm"
                    className="w-44 shrink-0"
                    placeholder={source.scope}
                    value={directScope}
                    onChange={(event) => setDirectScope(event.currentTarget.value)}
                    aria-label="Issue scope"
                  />
                }
                <Input
                  size="sm"
                  placeholder="Issue key, e.g. 42 or ENG-12"
                  value={directKey}
                  onChange={(event) => setDirectKey(event.currentTarget.value)}
                  aria-label="Issue key"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={directRef === null || !canLink || pendingKey !== null}
                >
                  Link key
                </Button>
              </form>
            ) : null}
            <div className="overflow-hidden rounded-md border border-border/60">
              <ScrollArea className="h-72">
                {emptyMessage !== null ? (
                  <p className="p-4 text-center text-sm text-muted-foreground">{emptyMessage}</p>
                ) : null}
                <div className="flex flex-col p-1">
                  {candidates.map((entry) => (
                    <button
                      key={`${entry.tracker}:${entry.host}:${entry.scope}:${entry.key}`}
                      type="button"
                      disabled={!canLink || pendingKey !== null}
                      onClick={() => void linkRef(entry, entry.url)}
                      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60 disabled:opacity-60"
                    >
                      <IssueStateGlyph state={entry.state} />
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {entry.displayKey}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                      {pendingKey === entry.key ? (
                        <span className="text-xs text-muted-foreground">Linking…</span>
                      ) : null}
                    </button>
                  ))}
                  {hasMore ? (
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      className="mx-auto my-1 w-fit"
                      disabled={listPending}
                      onClick={() => void loadMore()}
                    >
                      {listPending ? "Loading" : "Load more"}
                    </Button>
                  ) : null}
                </div>
              </ScrollArea>
            </div>
            {canLink ? null : (
              <p className="text-xs text-muted-foreground">
                This connection can't change thread links.
              </p>
            )}
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={pendingKey !== null} onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
