import type { PullRequestListFilters } from "@t3tools/contracts";

/** What `review:` and `status:` take, in GitHub's spelling and in the contract's. */
const REVIEW_VALUES: Record<string, PullRequestListFilters["review"]> = {
  approved: "approved",
  changes_requested: "changes-requested",
  "changes-requested": "changes-requested",
  required: "review-required",
  "review-required": "review-required",
  none: "none",
};
const CHECKS_VALUES: Record<string, PullRequestListFilters["checks"]> = {
  success: "passing",
  passing: "passing",
  failure: "failing",
  failing: "failing",
};

/**
 * One token of a typed query: a run of non-space characters in which a quoted stretch counts as
 * part of the token, so `label:"needs design"` stays whole. An unbalanced quote is dropped rather
 * than swallowing the rest of the line.
 */
const QUERY_TOKEN = /(?:[^\s"]|"[^"]*")+/g;
/** The contract's own ceilings on a qualifier: this many names, each this long. */
const MAX_QUALIFIER_VALUES = 10;
const MAX_QUALIFIER_LENGTH = 200;

function qualifierValue(raw: string): string {
  return raw.replaceAll('"', "").trim();
}

/** A qualifier's value as the list it may be: split on commas, each name unquoted on its own. */
function splitQualifierList(raw: string): string[] {
  return (raw.match(/(?:[^,"]|"[^"]*")+/g) ?? [])
    .map((part) => qualifierValue(part))
    .filter((part) => part.length > 0);
}

/**
 * A typed query is written by hand, and the contract bounds what a qualifier may carry — so what
 * is typed past those bounds is cut here rather than refused by the request that carries it.
 */
function boundedNames(names: ReadonlyArray<string>): string[] {
  return names
    .slice(0, MAX_QUALIFIER_VALUES)
    .map((name) => name.slice(0, MAX_QUALIFIER_LENGTH).trim())
    .filter((name) => name.length > 0);
}

/**
 * A typed query split into the qualifiers the hosts can act on and the text that is left. Written
 * GitHub's way — `label:foo`, `-label:"needs design"`, `author:octocat`, `draft:true`,
 * `review:approved`, `status:success` — because a project's labels are its own and a menu cannot
 * list them.
 *
 * A key this does not know is read as a label of that whole name: repositories namespace their
 * labels with a colon — `size:XXL`, `area:web`, `vouch:trusted` — and someone typing one means
 * the label, not a description that happens to contain it. `-size:XXL` excludes the same way.
 *
 * Quoting is the way back to plain text: `"size:XXL"` is searched for as written, which is what
 * makes a literal search for a colon still possible. A known key whose value it does not take is
 * text too, so a search for "status:" itself is still findable.
 */
export function parsePullRequestQuery(raw: string): {
  readonly text: string;
  readonly filters: PullRequestListFilters;
} {
  const text: string[] = [];
  const labels: string[][] = [];
  const excludedLabels: string[] = [];
  let author: string | undefined;
  let draft: PullRequestListFilters["draft"];
  let review: PullRequestListFilters["review"];
  let checks: PullRequestListFilters["checks"];
  for (const [token] of raw.matchAll(QUERY_TOKEN)) {
    const qualifier = /^(-?)([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(token);
    const value = qualifier === null ? "" : qualifierValue(qualifier[3] ?? "");
    const negated = qualifier?.[1] === "-";
    switch (value.length === 0 ? "" : (qualifier?.[2]?.toLowerCase() ?? "")) {
      case "label": {
        // GitHub's own OR: `label:a,b` is one qualifier satisfied by either name. Negated, the
        // comma excludes each — a row carrying any of them goes.
        const names = boundedNames(splitQualifierList(qualifier?.[3] ?? ""));
        if (names.length === 0) break;
        if (negated) excludedLabels.push(...names);
        else labels.push(names);
        continue;
      }
      case "author":
        if (negated) break;
        author = value.slice(0, MAX_QUALIFIER_LENGTH).trim();
        continue;
      case "draft":
        if (negated || (value.toLowerCase() !== "true" && value.toLowerCase() !== "false")) break;
        draft = value.toLowerCase() === "true" ? "only" : "hide";
        continue;
      case "review": {
        const decision = negated ? undefined : REVIEW_VALUES[value.toLowerCase()];
        if (decision === undefined) break;
        review = decision;
        continue;
      }
      case "status":
      case "checks": {
        const state = negated ? undefined : CHECKS_VALUES[value.toLowerCase()];
        if (state === undefined) break;
        checks = state;
        continue;
      }
      case "":
        break;
      default:
        // An unknown key, read as the namespaced label it almost always is. A pasted link is
        // not one — `https://…` would otherwise become a label named after its own scheme.
        if (!value.startsWith("/")) {
          // The key names the namespace, so the bare parts of `size:S,XS` are both sizes. A part
          // that already carries a colon names its whole label — `size:S,size:XS` is the same
          // pair written out, and prefixing it again would ask for `size:size:XS`.
          const names = boundedNames(
            splitQualifierList(qualifier?.[3] ?? "").map((name) =>
              name.includes(":") ? name : `${qualifier?.[2] ?? ""}:${name}`,
            ),
          );
          if (names.length === 0) break;
          if (negated) excludedLabels.push(...names);
          else labels.push(names);
          continue;
        }
    }
    text.push(token);
  }
  return {
    text: text.join(" "),
    filters: {
      ...(labels.length === 0 ? {} : { labels: labels.slice(0, MAX_QUALIFIER_VALUES) }),
      ...(excludedLabels.length === 0
        ? {}
        : { excludedLabels: excludedLabels.slice(0, MAX_QUALIFIER_VALUES) }),
      ...(author === undefined ? {} : { author }),
      ...(draft === undefined ? {} : { draft }),
      ...(review === undefined ? {} : { review }),
      ...(checks === undefined ? {} : { checks }),
    },
  };
}

export function applyPullRequestDraftFilterChange(
  raw: string,
  previousFilters: PullRequestListFilters,
  nextFilters: PullRequestListFilters,
) {
  const draft = parsePullRequestQuery(raw).filters.draft ?? previousFilters.draft;
  if (nextFilters.draft === draft)
    return { query: raw, filters: { ...nextFilters, draft: previousFilters.draft } };
  return {
    query: [...raw.matchAll(QUERY_TOKEN)]
      .map(([token]) => token)
      .filter((token) => parsePullRequestQuery(token).filters.draft === undefined)
      .join(" "),
    filters: nextFilters,
  };
}
