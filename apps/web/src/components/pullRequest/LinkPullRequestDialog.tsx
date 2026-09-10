import { changeRequestUrlFor as changeRequestWebUrl } from "@t3tools/shared/changeRequestUrl";
export { changeRequestUrlFor as changeRequestWebUrl } from "@t3tools/shared/changeRequestUrl";
import {
  pullRequestHostOf,
  type ScopedThreadRef,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";

import { parseChangeRequestUrl } from "~/lib/openPullRequestLink";
import { parsePullRequestReference } from "~/pullRequestReference";
import { useProjects, useThreadShell } from "~/state/entities";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Atom } from "effect/unstable/reactivity";
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
import { Checkbox } from "../ui/checkbox";

const linkPullRequestDialogThreadAtom = Atom.make<{
  threadRef: ScopedThreadRef;
  initialUrl: string | null;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("pull-requests:link-dialog-thread"));

export function openLinkPullRequestDialog(
  threadRef: ScopedThreadRef,
  initialUrl: string | null = null,
): void {
  appAtomRegistry.set(linkPullRequestDialogThreadAtom, { threadRef, initialUrl });
}

interface LinkPullRequestDialogProps {
  open: boolean;
  threadRef: ScopedThreadRef;
  /** The thread's own project: bare numbers resolve against its repository. */
  projectId: string | null;
  initialUrl: string | null;
  onOpenChange: (open: boolean) => void;
}

export function LinkPullRequestDialogHost() {
  const target = useAtomValue(linkPullRequestDialogThreadAtom);
  const threadRef = target?.threadRef ?? null;
  const thread = useThreadShell(threadRef);
  const linking = usePullRequestLinking(threadRef?.environmentId);
  if (threadRef === null || linking.mode === "unsupported") return null;
  return (
    <LinkPullRequestDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      open
      threadRef={threadRef}
      projectId={thread?.projectId ?? null}
      initialUrl={target?.initialUrl ?? null}
      onOpenChange={(open) => {
        if (!open) appAtomRegistry.set(linkPullRequestDialogThreadAtom, null);
      }}
    />
  );
}

interface ResolvedLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

/**
 * Which pull request an input names, or why it cannot. A URL carries its own host and
 * repository and may point at any repository on a host this environment has a project for; a
 * bare `#123` can only mean the thread's own repository.
 */
export function resolveLinkPullRequestInput(input: {
  readonly reference: string;
  readonly project: {
    readonly host: string;
    readonly repository: string;
    readonly webUrl: (number: number) => string | null;
  } | null;
  readonly hasProject: (reference: ResolvedLink) => boolean;
}): { link: ResolvedLink } | { error: string } | null {
  const parsed =
    parseChangeRequestUrl(input.reference.trim()) !== null
      ? input.reference.trim()
      : parsePullRequestReference(input.reference);
  if (parsed === null) return null;
  const url = parseChangeRequestUrl(parsed);
  if (url !== null) {
    if (!input.hasProject({ ...url, url: parsed })) {
      return { error: `No project in this environment can read ${url.host}/${url.repository}.` };
    }
    return {
      link: { host: url.host, repository: url.repository, number: url.number, url: parsed },
    };
  }
  const number = Number(parsed);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  if (input.project === null) {
    return { error: "Paste a full URL to link a pull request from another repository." };
  }
  const webUrl = input.project.webUrl(number);
  const webReference = webUrl === null ? null : parseChangeRequestUrl(webUrl);
  if (webUrl === null || webReference === null) {
    return { error: "Paste a full URL; this project's host has no known pull request URL." };
  }
  return {
    link: { ...webReference, url: webUrl },
  };
}

function LinkPullRequestDialog({
  open,
  threadRef,
  projectId,
  initialUrl,
  onOpenChange,
}: LinkPullRequestDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState("");
  const [dirty, setDirty] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const projects = useProjects();
  const thread = useThreadShell(threadRef);
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === threadRef.environmentId),
    [projects, threadRef.environmentId],
  );
  const ownProject = useMemo(() => {
    const project = environmentProjects.find((candidate) => candidate.id === projectId);
    const identity = project?.repositoryIdentity;
    if (!project || !identity) return null;
    const repository =
      identity.displayName ??
      (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
    if (repository === null) return null;
    const kind = identity.provider as SourceControlProviderKind;
    const host = pullRequestHostOf(identity, kind);
    return {
      id: project.id,
      host,
      repository,
      webUrl: (number: number) => changeRequestWebUrl(kind, host, repository, number),
    };
  }, [environmentProjects, projectId]);
  const linking = usePullRequestLinking(threadRef.environmentId);
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const suggestionsQuery = useEnvironmentQuery(
    open && linking.mode === "multiple" && ownProject !== null
      ? pullRequestEnvironment.list({
          environmentId: threadRef.environmentId,
          input: { projectId: ownProject.id, state: "open", involvement: "authored", limit: 20 },
        })
      : null,
  );
  const suggestions = useMemo(() => {
    const candidates = new Map<
      string,
      { url: string; number: number; title: string; headBranch: string | null }
    >();
    for (const link of visibleThreadPullRequests(thread?.pullRequests ?? [])) {
      candidates.set(threadPullRequestKeyOf(link), {
        ...link,
        title: link.snapshot?.title ?? link.repository,
        headBranch: link.snapshot?.headBranch ?? null,
      });
    }
    for (const url of [thread?.branchPullRequest?.url, initialUrl]) {
      const parsed = url ? parseChangeRequestUrl(url) : null;
      if (parsed === null || !url || candidates.has(threadPullRequestKeyOf(parsed))) continue;
      candidates.set(threadPullRequestKeyOf(parsed), {
        ...parsed,
        url,
        title: parsed.repository,
        headBranch: null,
      });
    }
    for (const entry of suggestionsQuery.data?.entries ?? []) {
      candidates.set(threadPullRequestKeyOf(entry), entry);
    }
    const matchesBranch = (entry: { url: string; headBranch: string | null }) =>
      entry.url === thread?.branchPullRequest?.url ||
      (thread?.branch != null && entry.headBranch === thread.branch);
    return [...candidates.values()]
      .filter((entry) => linking.canLink(entry.url))
      .toSorted((a, b) => Number(matchesBranch(b)) - Number(matchesBranch(a)));
  }, [initialUrl, linking, suggestionsQuery.data, thread]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const resolved = useMemo(
    () =>
      resolveLinkPullRequestInput({
        reference,
        project: ownProject,
        hasProject: (reference) => linking.canLink(reference.url),
      }),
    [linking, ownProject, reference],
  );

  const submit = useCallback(async () => {
    if (pending) return;
    let urls = selected.filter((url) => !linking.isLinked(thread, url));
    if (selected.length === 0) {
      setDirty(true);
      if (resolved === null || "error" in resolved) return;
      urls = [resolved.link.url];
    }
    setSubmitError(null);
    setPending(true);
    try {
      for (const url of urls) {
        await linking.changeLink(threadRef, url, true);
        setSelected((current) => current.filter((selectedUrl) => selectedUrl !== url));
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Could not link the pull request.");
      return;
    } finally {
      setPending(false);
    }
    onOpenChange(false);
  }, [linking, onOpenChange, pending, resolved, selected, thread, threadRef]);

  const validation = !dirty
    ? null
    : reference.trim().length === 0
      ? "Paste a pull request URL or enter 123 / #123."
      : resolved === null
        ? "Use a pull request URL, 123, or #123."
        : "error" in resolved
          ? resolved.error
          : null;

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Link pull request</DialogTitle>
          <DialogDescription>
            {linking.mode === "multiple"
              ? "Choose PRs to keep with this thread, or paste a pull request URL."
              : "Attach a pull request to this thread. A full URL can point at any repository on a host this environment has a project for."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {linking.mode === "multiple" ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Your recent PRs in this project</p>
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {suggestions.map((suggestion) => {
                  const linked = linking.isLinked(thread, suggestion.url);
                  return (
                    <label
                      key={suggestion.url}
                      className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50"
                    >
                      <Checkbox
                        aria-label={`Link #${suggestion.number} ${suggestion.title}`}
                        checked={linked || selected.includes(suggestion.url)}
                        disabled={linked || pending}
                        onCheckedChange={(checked) => {
                          setReference("");
                          setDirty(false);
                          setSubmitError(null);
                          setSelected((current) =>
                            checked
                              ? [...current, suggestion.url]
                              : current.filter((url) => url !== suggestion.url),
                          );
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        #{suggestion.number} {suggestion.title}
                      </span>
                      {linked ? (
                        <span className="text-xs text-muted-foreground">Linked</span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
              {suggestionsQuery.isPending ? (
                <p className="text-xs text-muted-foreground">Loading PR suggestions...</p>
              ) : null}
              {suggestionsQuery.error !== null || suggestionsQuery.data?.errors.length ? (
                <p className="text-xs text-muted-foreground">
                  Could not load PR suggestions. You can still paste a URL below.
                </p>
              ) : suggestions.length === 0 && !suggestionsQuery.isPending ? (
                <p className="text-xs text-muted-foreground">
                  No recent open PRs found. Paste a URL below.
                </p>
              ) : null}
            </div>
          ) : null}
          <Input
            ref={inputRef}
            placeholder="Pull request URL or #42"
            value={reference}
            disabled={pending}
            onChange={(event) => {
              setSelected([]);
              setDirty(true);
              setReference(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void submit();
            }}
          />
          {resolved !== null && "link" in resolved ? (
            <p className="truncate text-muted-foreground text-xs">
              {resolved.link.host}/{resolved.link.repository} #{resolved.link.number}
            </p>
          ) : null}
          {(validation ?? submitError) ? (
            <p className="text-destructive text-xs">{validation ?? submitError}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={
              pending || (selected.length === 0 && (resolved === null || "error" in resolved))
            }
          >
            {pending
              ? "Linking..."
              : selected.length > 0
                ? `Link ${selected.length} PR${selected.length === 1 ? "" : "s"}`
                : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
