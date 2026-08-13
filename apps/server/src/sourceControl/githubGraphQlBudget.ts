const GRAPHQL_RESERVE_RATIO = 0.1;
const RATE_LIMIT_SELECTION = "rateLimit { cost limit remaining resetAt }";

interface GraphQlBudgetSnapshot {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: string;
  readonly resetAtMs: number;
}

export type GitHubGraphQlBudgetDecision =
  | { readonly _tag: "Allowed"; readonly query: string }
  | { readonly _tag: "Paused"; readonly resetAt: string };

export interface GitHubGraphQlBudget {
  readonly query: (host: string, document: string, now?: number) => GitHubGraphQlBudgetDecision;
  readonly observe: (host: string, raw: string) => void;
  readonly reset: () => void;
}

function hostKey(host: string): string {
  return host.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function snapshotFrom(raw: string): GraphQlBudgetSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.data) || !isRecord(parsed.data.rateLimit)) {
      return null;
    }
    const { limit, remaining, resetAt } = parsed.data.rateLimit;
    if (
      typeof limit !== "number" ||
      !Number.isFinite(limit) ||
      limit <= 0 ||
      typeof remaining !== "number" ||
      !Number.isFinite(remaining) ||
      remaining < 0 ||
      typeof resetAt !== "string"
    ) {
      return null;
    }
    const resetAtMs = Date.parse(resetAt);
    return Number.isFinite(resetAtMs) ? { limit, remaining, resetAt, resetAtMs } : null;
  } catch {
    return null;
  }
}

function withRateLimit(document: string): string {
  const operation = document.trimStart();
  if (!operation.startsWith("query") && !operation.startsWith("{")) return document;
  const end = document.lastIndexOf("}");
  if (end === -1 || document.includes(RATE_LIMIT_SELECTION)) return document;
  return `${document.slice(0, end)}\n  ${RATE_LIMIT_SELECTION}\n${document.slice(end)}`;
}

export function createGitHubGraphQlBudget(): GitHubGraphQlBudget {
  const snapshots = new Map<string, GraphQlBudgetSnapshot>();

  return {
    // @effect-diagnostics-next-line globalDate:off
    query: (host, document, now = Date.now()) => {
      const key = hostKey(host);
      const snapshot = snapshots.get(key);
      if (snapshot !== undefined && snapshot.resetAtMs <= now) snapshots.delete(key);
      if (
        snapshot !== undefined &&
        snapshot.resetAtMs > now &&
        snapshot.remaining <= snapshot.limit * GRAPHQL_RESERVE_RATIO
      ) {
        return { _tag: "Paused", resetAt: snapshot.resetAt };
      }
      return { _tag: "Allowed", query: withRateLimit(document) };
    },
    observe: (host, raw) => {
      const snapshot = snapshotFrom(raw);
      if (snapshot !== null) snapshots.set(hostKey(host), snapshot);
    },
    reset: () => {
      snapshots.clear();
    },
  };
}

/**
 * One budget per server process. Pull request and issue registries create separate provider
 * layers, but GitHub applies one quota to the account behind both.
 */
export const githubGraphQlBudget = createGitHubGraphQlBudget();
