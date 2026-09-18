import { githubMediaFetchUrl } from "./githubMedia.ts";
import type { SourceControlProviderKind } from "@t3tools/contracts";

export function pullRequestMediaUrl(input: {
  readonly provider: SourceControlProviderKind;
  readonly host: string | undefined;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}): string | null {
  if (!input.host || /[\\\p{Cc}]/u.test(input.url)) return null;
  try {
    if (input.provider === "github") {
      if (input.host !== "github.com") return null;
      const media = githubMediaFetchUrl(input.url);
      if (!media) return null;
      const parsed = new URL(media);
      const path = parsed.pathname.replace(/^\//, "");
      return path.startsWith("user-attachments/") ||
        path.startsWith(`${input.repository}/`) ||
        path.startsWith(`media/${input.repository}/`)
        ? media
        : null;
    }
    const origin = new URL(`https://${input.host}`);
    const source =
      input.provider === "gitlab" && input.url.startsWith("/uploads/")
        ? `/${input.repository}${input.url}`
        : input.url;
    const url = new URL(source, origin);
    const azureAlias =
      input.provider === "azure-devops" &&
      origin.hostname === "dev.azure.com" &&
      url.hostname === `${input.repository.split("/")[0]?.toLowerCase()}.visualstudio.com` &&
      !url.port;
    if (
      url.protocol !== "https:" ||
      (url.host !== origin.host && !azureAlias) ||
      url.username ||
      url.password ||
      url.hash
    )
      return null;
    const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
    if (parts.some((part) => !part || part === "." || part === ".." || /[/\\\p{Cc}]/u.test(part)))
      return null;
    const repository = input.repository.split("/");
    switch (input.provider) {
      case "gitlab": {
        const prefix = parts.slice(0, repository.length).join("/");
        const relative = parts.slice(repository.length);
        const upload =
          prefix === input.repository
            ? relative[0] === "-"
              ? relative.slice(1)
              : relative
            : parts[0] === "-" && parts[1] === "project" && /^\d+$/.test(parts[2] ?? "")
              ? parts.slice(3)
              : [];
        return upload.length === 3 &&
          upload[0] === "uploads" &&
          /^[a-f\d]{32}$/i.test(upload[1] ?? "") &&
          !url.search
          ? url.href
          : null;
      }
      case "forgejo": {
        const prefix = parts.slice(0, -2).join("/");
        return (prefix === repository.slice(0, -2).join("/") || prefix === input.repository) &&
          parts.at(-2) === "attachments" &&
          /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(parts.at(-1) ?? "") &&
          !url.search
          ? url.href
          : null;
      }
      case "bitbucket":
        return url.hostname === "bitbucket.org" &&
          parts.length === repository.length + 2 &&
          parts.slice(0, repository.length).join("/") === input.repository &&
          parts[repository.length] === "downloads" &&
          !url.search
          ? url.href
          : null;
      case "azure-devops": {
        const api = parts.indexOf("_apis");
        const tail = parts.slice(api + 1);
        return api > 0 &&
          tail.length === 7 &&
          tail[0] === "git" &&
          tail[1] === "repositories" &&
          tail[3] === "pullRequests" &&
          tail[4] === String(input.number) &&
          tail[5] === "attachments" &&
          (url.hostname === "dev.azure.com" || url.hostname.endsWith(".visualstudio.com"))
          ? url.href
          : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
