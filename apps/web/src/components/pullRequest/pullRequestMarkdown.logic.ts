/** `id` is positional on purpose: the same attachment can be embedded twice in one body. */
export type PullRequestBodySegment =
  | { readonly id: string; readonly kind: "markdown"; readonly text: string }
  | { readonly id: string; readonly kind: "video"; readonly url: string };

const FENCE_PATTERN = /^\s{0,3}((?:`{3,})|(?:~{3,}))(.*)$/u;
/** Four spaces open an indented code block, so its contents stay verbatim markdown. */
const INDENTED_CODE_PATTERN = /^(?: {4}|\t)/u;
const BARE_URL_PATTERN = /^<?(https?:\/\/\S+?)>?$/u;
const VIDEO_EXTENSION_PATTERN = /\.(?:mp4|webm|mov|m4v|ogv)(?:$|[?#])/iu;
/** A dropped video becomes a bare asset link; a dropped image becomes `![alt](…)`. */
const GITHUB_ASSET_PATTERN = /^https:\/\/github\.com\/user-attachments\/assets\/[\w-]+$/iu;
const VIDEO_TAG_SRC_PATTERN = /<(?:video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/iu;
/** Only a tag that owns its line is an embed; inline, it is prose the renderer should keep. */
const STANDALONE_VIDEO_TAG_PATTERN = /^\s*<video\b/iu;
const VIDEO_TAG_END_PATTERN = /<\/video>\s*$/iu;

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
  let openFence: string | null = null;

  // Blank lines around a run are dropped, but never leading spaces: four of them open an
  // indented code block, so trimming a run would silently turn code into prose.
  const flushMarkdown = () => {
    const text = markdown.join("\n").replace(/^\n+/u, "").replace(/\s+$/u, "");
    markdown.length = 0;
    if (text.trim().length > 0) {
      segments.push({ id: `markdown:${segments.length}`, kind: "markdown", text });
    }
  };

  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fenceMatch !== null) {
      const fence = fenceMatch[1]!;
      // A fence closes only on the same marker, at least as long as the one that opened it,
      // and with nothing after it: `~~~` cannot end a ``` block, and ```` ```ts ```` is an
      // info string opening a nested fence, not a close.
      const closes =
        openFence !== null &&
        fence[0] === openFence[0] &&
        fence.length >= openFence.length &&
        fenceMatch[2]!.trim().length === 0;
      if (openFence === null) {
        openFence = fence;
      } else if (closes) {
        openFence = null;
      }
      markdown.push(line);
      continue;
    }
    if (openFence !== null || INDENTED_CODE_PATTERN.test(line)) {
      markdown.push(line);
      continue;
    }

    const bareVideo = videoUrlFromLine(line);
    if (bareVideo !== null) {
      flushMarkdown();
      segments.push({ id: `video:${segments.length}`, kind: "video", url: bareVideo });
      continue;
    }

    if (!STANDALONE_VIDEO_TAG_PATTERN.test(line)) {
      markdown.push(line);
      continue;
    }
    // A tag can span lines; consume through its close before looking for the source.
    let block = line;
    let cursor = index;
    while (!VIDEO_TAG_END_PATTERN.test(block) && cursor + 1 < lines.length) {
      cursor += 1;
      block += `\n${lines[cursor]!}`;
    }
    const source = VIDEO_TAG_END_PATTERN.test(block)
      ? VIDEO_TAG_SRC_PATTERN.exec(block)?.[1]
      : undefined;
    if (source !== undefined && isPlayableUrl(source)) {
      flushMarkdown();
      segments.push({ id: `video:${segments.length}`, kind: "video", url: source });
      index = cursor;
    } else {
      markdown.push(line);
    }
  }

  flushMarkdown();
  return segments;
}
