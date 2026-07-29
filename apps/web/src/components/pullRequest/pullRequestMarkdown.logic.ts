/** `id` is positional on purpose: the same attachment can be embedded twice in one body. */
export type PullRequestBodySegment =
  | { readonly id: string; readonly kind: "markdown"; readonly text: string }
  | { readonly id: string; readonly kind: "video"; readonly url: string };

const FENCE_PATTERN = /^\s{0,3}(?:`{3,}|~{3,})/u;
const BARE_URL_PATTERN = /^<?(https?:\/\/\S+?)>?$/u;
const VIDEO_EXTENSION_PATTERN = /\.(?:mp4|webm|mov|m4v|ogv)(?:$|[?#])/iu;
/** A dropped video becomes a bare asset link; a dropped image becomes `![alt](…)`. */
const GITHUB_ASSET_PATTERN = /^https:\/\/github\.com\/user-attachments\/assets\/[\w-]+$/iu;
const VIDEO_TAG_SRC_PATTERN = /<(?:video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/iu;

function isPlayableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function videoUrlFromLine(line: string): string | null {
  const bare = BARE_URL_PATTERN.exec(line.trim())?.[1];
  if (bare === undefined) return null;
  const isVideo = VIDEO_EXTENSION_PATTERN.test(bare) || GITHUB_ASSET_PATTERN.test(bare);
  return isVideo && isPlayableUrl(bare) ? bare : null;
}

/**
 * Splits a pull request body into markdown runs and the videos embedded in it, which the
 * markdown renderer has no element for. Two shapes are recognised, both of which GitHub
 * produces itself: a `<video>` (or `<source>`) tag, and a bare link on its own line to a
 * video file or an uploaded attachment. Fenced code is copied through untouched so a snippet
 * that happens to contain a link is never turned into a player.
 */
export function splitPullRequestBody(body: string): ReadonlyArray<PullRequestBodySegment> {
  const segments: PullRequestBodySegment[] = [];
  const markdown: string[] = [];
  let insideFence = false;

  const flushMarkdown = () => {
    const text = markdown.join("\n").trim();
    markdown.length = 0;
    if (text.length > 0) {
      segments.push({ id: `markdown:${segments.length}`, kind: "markdown", text });
    }
  };

  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (FENCE_PATTERN.test(line)) {
      insideFence = !insideFence;
      markdown.push(line);
      continue;
    }
    if (insideFence) {
      markdown.push(line);
      continue;
    }

    const bareVideo = videoUrlFromLine(line);
    if (bareVideo !== null) {
      flushMarkdown();
      segments.push({ id: `video:${segments.length}`, kind: "video", url: bareVideo });
      continue;
    }

    if (!/<video\b/iu.test(line)) {
      markdown.push(line);
      continue;
    }
    // A tag can span lines; consume through its close before looking for the source.
    let block = line;
    while (!/<\/video>/iu.test(block) && index + 1 < lines.length) {
      index += 1;
      block += `\n${lines[index]!}`;
    }
    const source = VIDEO_TAG_SRC_PATTERN.exec(block)?.[1];
    if (source !== undefined && isPlayableUrl(source)) {
      flushMarkdown();
      segments.push({ id: `video:${segments.length}`, kind: "video", url: source });
    } else {
      markdown.push(block);
    }
  }

  flushMarkdown();
  return segments;
}
