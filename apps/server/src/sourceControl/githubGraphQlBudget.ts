import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

const GRAPHQL_RESERVE_RATIO = 0.1;
const RATE_LIMIT_SELECTION = "rateLimit { cost limit remaining resetAt }";

interface GraphQlBudgetSnapshot {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: string;
  readonly resetAtMs: number;
}

export class GitHubGraphQlBudgetPausedError extends Schema.TaggedErrorClass<GitHubGraphQlBudgetPausedError>()(
  "GitHubGraphQlBudgetPausedError",
  {
    host: Schema.String,
    resetAt: Schema.String,
  },
) {
  get detail(): string {
    return `GraphQL reads for ${this.host} are paused until ${this.resetAt}.`;
  }

  override get message(): string {
    return `GitHub ${this.detail}`;
  }
}

export class GitHubGraphQlBudget extends Context.Service<
  GitHubGraphQlBudget,
  {
    readonly query: (
      host: string,
      document: string,
    ) => Effect.Effect<string, GitHubGraphQlBudgetPausedError>;
    readonly observe: (host: string, raw: string) => Effect.Effect<void>;
  }
>()("t3/sourceControl/githubGraphQlBudget") {}

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

export const make = Effect.gen(function* () {
  const snapshots = yield* Ref.make<ReadonlyMap<string, GraphQlBudgetSnapshot>>(new Map());

  const query: GitHubGraphQlBudget["Service"]["query"] = Effect.fn("GitHubGraphQlBudget.query")(
    function* (host, document) {
      const now = yield* Clock.currentTimeMillis;
      const resetAt = yield* Ref.modify(snapshots, (current) => {
        const key = hostKey(host);
        const snapshot = current.get(key);
        if (snapshot === undefined) return [null, current] as const;
        if (snapshot.resetAtMs <= now) {
          const next = new Map(current);
          next.delete(key);
          return [null, next] as const;
        }
        return [
          snapshot.remaining <= snapshot.limit * GRAPHQL_RESERVE_RATIO ? snapshot.resetAt : null,
          current,
        ] as const;
      });
      if (resetAt !== null) {
        return yield* new GitHubGraphQlBudgetPausedError({ host, resetAt });
      }
      return withRateLimit(document);
    },
  );

  const observe: GitHubGraphQlBudget["Service"]["observe"] = Effect.fn(
    "GitHubGraphQlBudget.observe",
  )(function* (host, raw) {
    const snapshot = snapshotFrom(raw);
    if (snapshot === null) return;
    yield* Ref.update(snapshots, (current) => {
      const key = hostKey(host);
      const previous = current.get(key);
      // Concurrent reads can finish out of order. Quota only falls within one reset window, and
      // an answer from an older window must not replace the current one.
      if (
        previous !== undefined &&
        (snapshot.resetAtMs < previous.resetAtMs ||
          (snapshot.resetAtMs === previous.resetAtMs && snapshot.remaining >= previous.remaining))
      ) {
        return current;
      }
      const next = new Map(current);
      next.set(key, snapshot);
      return next;
    });
  });

  return GitHubGraphQlBudget.of({ query, observe });
});

export const layer = Layer.effect(GitHubGraphQlBudget, make);
