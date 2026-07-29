import { cn } from "~/lib/utils";

import ChatMarkdown from "../ChatMarkdown";
import { splitPullRequestBody } from "./pullRequestMarkdown.logic";

/**
 * A pull request body, rendered with the app's markdown renderer plus inline players for the
 * videos GitHub embeds — the renderer has no element for those, so they would otherwise show
 * up as a bare link.
 */
export function PullRequestMarkdown({
  text,
  cwd,
  className,
}: {
  text: string;
  cwd: string;
  className?: string;
}) {
  const segments = splitPullRequestBody(text);
  return (
    <div className={cn("space-y-3", className)}>
      {segments.map((segment) =>
        segment.kind === "video" ? (
          <video
            key={segment.id}
            controls
            preload="metadata"
            src={segment.url}
            className="max-h-96 w-full rounded-lg border border-border/60 bg-black"
          >
            <a href={segment.url} rel="noreferrer noopener" target="_blank">
              Open video
            </a>
          </video>
        ) : (
          <ChatMarkdown key={segment.id} text={segment.text} cwd={cwd} />
        ),
      )}
    </div>
  );
}
