import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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

export interface GitHubGraphQlBudgetState {
  readonly query: (host: string, document: string, now: number) => GitHubGraphQlBudgetDecision;
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

/**
 * Finds the first operation close: empty or malformed documents return -1; nested selections balance.
 * ponytail: Read queries are internal templates without brace-bearing string literals; use a
 * GraphQL parser if user-authored documents ever reach this helper.
 */
function operationSelectionEnd(document: string): number {
  const start = document.indexOf("{");
  if (start === -1) return -1;
  let depth = 0;
  for (let index = start; index < document.length; index += 1) {
    const character = document[index];
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function withRateLimit(document: string): string {
  const operation = document.trimStart();
  if (!operation.startsWith("query") && !operation.startsWith("{")) return document;
  const end = operationSelectionEnd(document);
  if (end === -1 || document.includes(RATE_LIMIT_SELECTION)) return document;
  return `${document.slice(0, end)}\n  ${RATE_LIMIT_SELECTION}\n${document.slice(end)}`;
}

export function createGitHubGraphQlBudget(): GitHubGraphQlBudgetState {
  const snapshots = new Map<string, GraphQlBudgetSnapshot>();

  return {
    query: (host, document, now) => {
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

export class GitHubGraphQlBudget extends Context.Service<
  GitHubGraphQlBudget,
  {
    readonly query: (host: string, document: string) => Effect.Effect<GitHubGraphQlBudgetDecision>;
    readonly observe: (host: string, raw: string) => Effect.Effect<void>;
    readonly reset: Effect.Effect<void>;
  }
>()("t3/sourceControl/githubGraphQlBudget") {}

export const make = Effect.sync(() => {
  const state = createGitHubGraphQlBudget();
  const query = Effect.fn("GitHubGraphQlBudget.query")(function* (host: string, document: string) {
    const now = yield* Clock.currentTimeMillis;
    return state.query(host, document, now);
  });

  return GitHubGraphQlBudget.of({
    query,
    observe: (host, raw) => Effect.sync(() => state.observe(host, raw)),
    reset: Effect.sync(state.reset),
  });
});

export const layer = Layer.effect(GitHubGraphQlBudget, make);
