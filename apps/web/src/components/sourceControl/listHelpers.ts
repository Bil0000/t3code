/**
 * The two judgements an issue list and a pull request list make the same way. Everything else each
 * list does — what it groups by, what it searches over, how it scores a match — is asked of fields
 * only that list's rows carry, and stays with it.
 */

/** Hosts differ on the case and padding they hand back, and a handle is neither. */
export function normalizeLogin(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Authorship is per host, not per provider kind: the same list can hold rows from GitHub, GitLab
 * and a GitHub Enterprise install, and the account that owns one says nothing about the others.
 */
export function isAuthoredByViewer(
  entry: {
    readonly host: string;
    readonly author?: { readonly login: string } | null | undefined;
  },
  viewers: Readonly<Record<string, string>>,
): boolean {
  const viewer = normalizeLogin(viewers[entry.host]);
  return viewer !== null && normalizeLogin(entry.author?.login) === viewer;
}
