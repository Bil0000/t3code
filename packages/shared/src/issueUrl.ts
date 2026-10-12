import type { IssueProviderKind } from "@t3tools/contracts";

export function parseIssueUrl(raw: string, options?: { readonly provider?: IssueProviderKind }) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const host = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const knownProvider =
    hostname === "github.com"
      ? "github"
      : hostname === "gitlab.com"
        ? "gitlab"
        : hostname === "linear.app"
          ? "linear"
          : hostname === "dev.azure.com" || /^[^.]+\.visualstudio\.com$/u.test(hostname)
            ? "azure-devops"
            : hostname === "bitbucket.org"
              ? "bitbucket"
              : hostname === "codeberg.org"
                ? "forgejo"
                : undefined;
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && options?.provider && !knownProvider)
  )
    return null;
  if (knownProvider && options?.provider && knownProvider !== options.provider) return null;
  if (knownProvider && url.port && !options?.provider) return null;
  const provider = knownProvider ?? options?.provider;
  if (!provider) return null;
  const segments: string[] = [];
  try {
    for (const segment of url.pathname.split("/").filter(Boolean)) {
      const decoded = decodeURIComponent(segment);
      if (!decoded || /[/\\\p{Cc}]/u.test(decoded) || decoded === "." || decoded === "..") {
        return null;
      }
      segments.push(decoded);
    }
  } catch {
    return null;
  }
  let repository: string;
  let numberText: string;
  let path: string[];
  if (provider === "linear") {
    if (
      hostname !== "linear.app" ||
      segments[1] !== "issue" ||
      segments.length < 3 ||
      segments.length > 4
    )
      return null;
    const match = /^([a-z][a-z0-9]*)-([1-9]\d*)$/iu.exec(segments[2]!);
    if (!match) return null;
    repository = match[1]!.toUpperCase();
    numberText = match[2]!;
    path = [segments[0]!, "issue", `${repository}-${numberText}`];
  } else if (provider === "azure-devops") {
    const modern = hostname === "dev.azure.com";
    const parts = modern
      ? segments
      : segments[0]?.toLowerCase() === "defaultcollection"
        ? segments.slice(1)
        : segments;
    if (
      parts.length !== (modern ? 5 : 4) ||
      parts.at(-3) !== "_workitems" ||
      parts.at(-2) !== "edit"
    )
      return null;
    const org = modern ? parts[0]! : hostname.split(".")[0]!;
    const project = modern ? parts[1]! : parts[0]!;
    repository = `${org}/${project}`;
    numberText = parts.at(-1)!;
    path = segments;
  } else {
    const issueIndex = provider === "gitlab" ? segments.length - 2 : 2;
    if (
      (segments[issueIndex] !== "issues" &&
        !(provider === "gitlab" && segments[issueIndex] === "work_items")) ||
      (segments.length !== issueIndex + 2 &&
        !(provider === "bitbucket" && segments.length === issueIndex + 3))
    )
      return null;
    const repoSegments = segments.slice(0, issueIndex);
    if (provider === "gitlab" && repoSegments.at(-1) === "-") repoSegments.pop();
    if (repoSegments.length < 2 || (provider !== "gitlab" && repoSegments.length !== 2))
      return null;
    repository = repoSegments.join("/");
    numberText = segments[issueIndex + 1]!;
    path =
      provider === "gitlab"
        ? [...repoSegments, "-", "issues", numberText]
        : [...repoSegments, "issues", numberText];
  }
  if (!/^[1-9]\d*$/u.test(numberText)) return null;
  const number = Number(numberText);
  if (!Number.isSafeInteger(number)) return null;
  const canonical =
    provider === "azure-devops"
      ? `https://dev.azure.com/${repository.split("/").map(encodeURIComponent).join("/")}/_workitems/edit/${number}`
      : `${url.protocol}//${host}/${path.map(encodeURIComponent).join("/")}`;
  return { provider, host, repository, number, url: canonical };
}
