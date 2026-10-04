import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useIssueLinking } from "~/hooks/useIssueLinking";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { parseIssueUrl, resolveIssueReference } from "~/lib/issueReference";
import { parseChangeRequestUrl } from "~/lib/openPullRequestLink";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useServerConfigs, useThreadShell } from "~/state/entities";
import {
  pullRequestProjectOf,
  resolveLinkPullRequestInput,
} from "./pullRequest/linkPullRequestReference";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Toggle, ToggleGroup } from "./ui/toggle-group";
import { threadPullRequestLinkMode } from "@t3tools/client-runtime/thread-pull-request-compatibility";

export type LinkThreadItemKind = "pull-request" | "issue";

/**
 * Which thread has the link dialog open, and which kind it starts on. Set by whichever entry
 * point asked (command palette, Linked items tab) and rendered once by the chat view, so the
 * dialog outlives a palette that closes the moment its command runs.
 */
const linkThreadItemDialogAtom = Atom.make<{
  readonly id: number;
  readonly threadRef: ScopedThreadRef;
  readonly kind: LinkThreadItemKind | null;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("thread-links:link-dialog"));

let nextLinkDialogId = 0;

/** Without a kind, the dialog starts on pull requests where the environment links them. */
export function openLinkThreadItemDialog(
  threadRef: ScopedThreadRef,
  kind: LinkThreadItemKind | null = null,
): void {
  nextLinkDialogId += 1;
  appAtomRegistry.set(linkThreadItemDialogAtom, { id: nextLinkDialogId, threadRef, kind });
}

/** What the dialog says and allows for the current input. */
export function linkDialogStatus(input: {
  readonly noun: string;
  readonly kindSupported: boolean;
  readonly dirty: boolean;
  readonly reference: string;
  readonly resolved: { readonly error: string } | object | null;
  readonly alreadyLinked: boolean;
}): { readonly canSubmit: boolean; readonly message: string | null } {
  const { noun } = input;
  const article = noun === "issue" ? "an" : "a";
  if (!input.kindSupported) {
    return {
      canSubmit: false,
      message: `This environment cannot link ${noun}s.`,
    };
  }
  if (input.resolved === null || "error" in input.resolved) {
    const message = !input.dirty
      ? null
      : input.reference.trim().length === 0
        ? `Paste ${article} ${noun} URL or enter #42.`
        : input.resolved === null
          ? `Use ${article} ${noun} URL, owner/repo#42, or #42.`
          : input.resolved.error;
    return { canSubmit: false, message };
  }
  return {
    canSubmit: !input.alreadyLinked,
    message: input.alreadyLinked ? `This ${noun} is already linked.` : null,
  };
}

/**
 * The kind a pasted URL names, or null when the input does not say (a bare `42` or `#42`).
 * Both hosts keep the two apart in the path: GitHub's `/pull/` and `/issues/`, GitLab's
 * `/-/merge_requests/` and `/-/issues/`.
 */
export function linkThreadItemKindOf(reference: string): LinkThreadItemKind | null {
  const trimmed = reference.trim();
  if (parseChangeRequestUrl(trimmed) !== null) return "pull-request";
  if (parseIssueUrl(trimmed) !== null) return "issue";
  return null;
}

/** Mounted once per chat view; shows the dialog for whichever thread asked for it. */
export function LinkThreadItemDialogHost() {
  const request = useAtomValue(linkThreadItemDialogAtom);
  const configs = useServerConfigs();
  const capabilities =
    request === null
      ? undefined
      : configs.get(request.threadRef.environmentId)?.environment.capabilities;
  const supportsPullRequests = threadPullRequestLinkMode(capabilities) !== "unsupported";
  const supportsIssues = capabilities?.issues === true;
  if (request === null || (!supportsPullRequests && !supportsIssues)) return null;
  const initialKind =
    request.kind === "issue" && supportsIssues
      ? "issue"
      : supportsPullRequests
        ? "pull-request"
        : "issue";
  return (
    <LinkThreadItemDialog
      key={request.id}
      threadRef={request.threadRef}
      initialKind={initialKind}
      supportsPullRequests={supportsPullRequests}
      supportsIssues={supportsIssues}
      onClose={() => appAtomRegistry.set(linkThreadItemDialogAtom, null)}
    />
  );
}

function LinkThreadItemDialog({
  threadRef,
  initialKind,
  supportsPullRequests,
  supportsIssues,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  initialKind: LinkThreadItemKind;
  supportsPullRequests: boolean;
  supportsIssues: boolean;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState("");
  const [chosenKind, setChosenKind] = useState(initialKind);
  const [dirty, setDirty] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const thread = useThreadShell(threadRef);
  const pullRequestLinking = usePullRequestLinking(threadRef.environmentId);
  const issueLinking = useIssueLinking(threadRef.environmentId);
  const projects = issueLinking.projects;
  const projectId = thread?.projectId ?? null;
  const repositoryIdentity = projects.find(
    (project) => project.id === projectId,
  )?.repositoryIdentity;
  const ownPullRequestProject = useMemo(
    () => pullRequestProjectOf(repositoryIdentity),
    [repositoryIdentity],
  );

  // A pasted URL says what it is; the toggle only decides for bare numbers.
  const detectedKind = linkThreadItemKindOf(reference);
  const kind = detectedKind ?? chosenKind;
  const kindSupported = kind === "pull-request" ? supportsPullRequests : supportsIssues;
  const noun = kind === "pull-request" ? "pull request" : "issue";

  const pullRequestResolved = useMemo(
    () =>
      kind === "pull-request"
        ? resolveLinkPullRequestInput({
            reference,
            project: ownPullRequestProject,
            hasProject: (link) => pullRequestLinking.canLink(link.url),
          })
        : null,
    [kind, ownPullRequestProject, pullRequestLinking, reference],
  );
  const issueResolved = useMemo(
    () => (kind === "issue" ? resolveIssueReference({ reference, projects, projectId }) : null),
    [kind, projectId, projects, reference],
  );
  const resolved = kind === "pull-request" ? pullRequestResolved : issueResolved;

  // Known from the pasted URL alone; a bare issue number is checked when the link is made.
  const alreadyLinked =
    pullRequestResolved !== null && "link" in pullRequestResolved
      ? pullRequestLinking.isLinked(thread, pullRequestResolved.link.url)
      : detectedKind === "issue" &&
        issueLinking.linkedIssueFor(threadRef, reference.trim()) !== null;
  const status = linkDialogStatus({
    noun,
    kindSupported,
    dirty,
    reference,
    resolved,
    alreadyLinked,
  });

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const submit = useCallback(async () => {
    if (pending) return;
    setDirty(true);
    if (!status.canSubmit) return;
    setSubmitError(null);
    setPending(true);
    try {
      if (pullRequestResolved !== null && "link" in pullRequestResolved) {
        await pullRequestLinking.changeLink(threadRef, pullRequestResolved.link.url, true);
      } else if (issueResolved !== null && "ref" in issueResolved) {
        await issueLinking.link(threadRef, issueResolved.ref);
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : `Could not link the ${noun}.`);
      return;
    } finally {
      setPending(false);
    }
    onClose();
  }, [
    issueLinking,
    issueResolved,
    noun,
    onClose,
    pending,
    pullRequestLinking,
    pullRequestResolved,
    status.canSubmit,
    threadRef,
  ]);

  const bothKinds = supportsPullRequests && supportsIssues;

  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{bothKinds ? "Link to thread" : `Link ${noun} to thread`}</DialogTitle>
          <DialogDescription>
            {bothKinds
              ? "Attach a pull request or an issue to this thread."
              : `Attach ${kind === "issue" ? "an" : "a"} ${noun} to this thread.`}{" "}
            A full URL can point at any repository a project in this environment reads.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {bothKinds ? (
              <ToggleGroup
                aria-label="What to link"
                className="w-full *:flex-1"
                value={[kind]}
                disabled={detectedKind !== null || pending}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "pull-request" || value === "issue") setChosenKind(value);
                  setSubmitError(null);
                }}
              >
                <Toggle value="pull-request">Pull request</Toggle>
                <Toggle value="issue">Issue</Toggle>
              </ToggleGroup>
            ) : null}
            <Input
              ref={inputRef}
              placeholder={`${kind === "pull-request" ? "Pull request" : "Issue"} URL or #42`}
              value={reference}
              readOnly={pending}
              onChange={(event) => {
                setDirty(true);
                setSubmitError(null);
                setReference(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void submit();
              }}
            />
            {(status.message ?? submitError) ? (
              <p className="text-destructive text-xs">{status.message ?? submitError}</p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={pending || !status.canSubmit}
          >
            {pending ? "Linking..." : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
