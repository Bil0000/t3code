import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const THREAD_LINK = /\[([^\]\n]{1,200})\]\((t3-thread:\/\/v1\/[^\s)]{1,1600})\)/g;
const decodeEnvironmentId = Schema.decodeUnknownSync(EnvironmentId);
const decodeThreadId = Schema.decodeUnknownSync(ThreadId);

export function parseThreadContextHref(href: string): ScopedThreadRef | null {
  const match = /^t3-thread:\/\/v1\/([^/]+)\/([^/]+)$/.exec(href);
  if (!match) return null;
  try {
    return {
      environmentId: decodeEnvironmentId(decodeURIComponent(match[1]!)),
      threadId: decodeThreadId(decodeURIComponent(match[2]!)),
    };
  } catch {
    return null;
  }
}

export function formatThreadContextLink(ref: ScopedThreadRef, title: string): string {
  const label =
    title
      .replace(/[[\]\\\r\n]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200) || "Thread";
  const href = `t3-thread://v1/${encodeURIComponent(ref.environmentId)}/${encodeURIComponent(ref.threadId)}`;
  return `[${label}](${href.replaceAll("(", "%28").replaceAll(")", "%29")})`;
}

export function collectThreadContextLinks(text: string) {
  if (!text.includes("](t3-thread:")) return [];
  return [...text.matchAll(THREAD_LINK)].flatMap((match) => {
    const ref = parseThreadContextHref(match[2]!);
    return ref
      ? [
          {
            ...ref,
            label: match[1]!,
            source: match[0],
            start: match.index,
            end: match.index + match[0].length,
          },
        ]
      : [];
  });
}

export function threadContextLinksToPlainText(text: string): string {
  return text.replace(THREAD_LINK, (source: string, label: string, href: string) =>
    parseThreadContextHref(href) ? label : source,
  );
}
