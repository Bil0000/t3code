import type { LocalApi } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { type MouseEvent, useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";

export class PullRequestLinkOpenError extends Schema.TaggedErrorClass<PullRequestLinkOpenError>()(
  "PullRequestLinkOpenError",
  {
    targetOrigin: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  static fromCause(targetUrl: string, cause: unknown): PullRequestLinkOpenError {
    let targetOrigin: string | null = null;
    try {
      targetOrigin = new URL(targetUrl).origin;
    } catch {
      // Keep malformed URLs out of diagnostics while preserving the open failure below.
    }
    return new PullRequestLinkOpenError({ targetOrigin, cause });
  }

  override get message(): string {
    return this.targetOrigin === null
      ? "Unable to open pull request link."
      : `Unable to open pull request link at ${this.targetOrigin}.`;
  }
}

export async function openPullRequestLink(
  shell: Pick<LocalApi["shell"], "openExternal">,
  targetUrl: string,
): Promise<void> {
  try {
    await shell.openExternal(targetUrl);
  } catch (cause) {
    throw PullRequestLinkOpenError.fromCause(targetUrl, cause);
  }
}

/**
 * `owner/repo` and the number behind a GitHub pull request URL, or null for anything else
 * (a GitLab merge request, an enterprise host path, a malformed link).
 */
export function parseGitHubPullRequestUrl(
  targetUrl: string,
): { readonly repository: string; readonly number: number } | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (!/(^|\.)github\.com$/iu.test(url.hostname)) return null;
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/u.exec(url.pathname);
  const owner = match?.[1];
  const name = match?.[2];
  const number = Number(match?.[3]);
  return owner && name && Number.isSafeInteger(number) && number > 0
    ? { repository: `${owner}/${name}`, number }
    : null;
}

/**
 * Returns a click handler that opens a pull request URL in the system browser.
 *
 * Stops event propagation/default so activating the link does not also trigger
 * an enclosing row or trigger (e.g. opening the branch dropdown), and surfaces a
 * toast when the local API is unavailable or the open fails.
 */
export function useOpenPrLink() {
  const navigate = useNavigate();
  return useCallback(
    (event: MouseEvent<HTMLElement>, prUrl: string) => {
      event.preventDefault();
      event.stopPropagation();

      // GitHub pull requests open on the in-app page, which offers the browser as one of its
      // actions. Everything else still goes straight out to the system browser.
      const parsed = parseGitHubPullRequestUrl(prUrl);
      if (parsed) {
        void navigate({
          to: "/pull-requests",
          search: {
            involvement: "all",
            state: "open",
            repository: parsed.repository,
            number: parsed.number,
          },
        });
        return;
      }

      const api = readLocalApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Link opening is unavailable.",
        });
        return;
      }

      void openPullRequestLink(api.shell, prUrl).catch((error) => {
        console.error(error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open pull request link",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      });
    },
    [navigate],
  );
}
